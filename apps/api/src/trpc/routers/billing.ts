import {
  cancelSubscriptionSchema,
  createCheckoutSchema,
  getBillingOrdersSchema,
} from "@api/schemas/billing";
import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import { api } from "@api/utils/polar";
import { getTeamById, updateTeamById } from "@midday/db/queries";
import { createLoggerWithContext } from "@midday/logger";
import { getPlanIntervalByProductId } from "@midday/plans";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

const logger = createLoggerWithContext("trpc:billing");

async function resolvePolarCustomer(
  db: Parameters<typeof getTeamById>[0],
  teamId: string,
): Promise<{ id: string }> {
  try {
    return await api.customers.getExternal({ externalId: teamId });
  } catch {
    // externalId may belong to a different team (same user, multiple teams).
    // Fall back to the team's stored email which matches the Polar customer.
    // team.email is set by the subscription webhook, so it's always available
    // by the time billing management endpoints are called.
    const team = await getTeamById(db, teamId);
    if (!team?.email) {
      logger.error("Cannot resolve Polar customer: team has no email", {
        teamId,
      });
      throw new Error("Failed to resolve Polar customer");
    }

    logger.info("Resolving Polar customer by email fallback", { teamId });

    const result = await api.customers.list({ email: team.email, limit: 1 });
    if (!result.result.items.length) {
      throw new Error("Failed to resolve Polar customer");
    }

    return result.result.items[0]!;
  }
}

export const billingRouter = createTRPCRouter({
  createCheckout: protectedProcedure
    .input(createCheckoutSchema)
    .mutation(async () => {
      // Wind-down: Midday is shutting down billing. New subscriptions and
      // trials are no longer accepted. Existing customers keep access via
      // their current plan; the Polar webhook preserves the plan when the
      // subscription is revoked at period end.
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "New subscriptions are no longer available.",
      });
    }),

  orders: protectedProcedure
    .input(getBillingOrdersSchema)
    .query(async ({ input, ctx: { db, teamId } }) => {
      try {
        const customer = await resolvePolarCustomer(db, teamId!);

        const ordersResult = await api.orders.list({
          customerId: customer.id,
          page: input.cursor ? Number(input.cursor) : 1,
          limit: input.pageSize,
        });

        const orders = ordersResult.result.items;
        const pagination = ordersResult.result.pagination;

        // Filter orders to only include those where metadata.teamId matches teamId
        const filteredOrders = orders.filter((order) => {
          const organizationId = order.metadata?.teamId;
          return organizationId === teamId;
        });

        return {
          data: filteredOrders.map((order) => ({
            id: order.id,
            createdAt: order.createdAt,
            amount: {
              amount: order.totalAmount,
              currency: order.currency,
            },
            status: order.status,
            product: {
              name: order.product?.name || "Subscription",
            },
            invoiceId: order.isInvoiceGenerated ? order.id : null,
          })),
          meta: {
            hasNextPage:
              (input.cursor ? Number(input.cursor) : 1) < pagination.maxPage,
            cursor:
              (input.cursor ? Number(input.cursor) : 1) < pagination.maxPage
                ? ((input.cursor ? Number(input.cursor) : 1) + 1).toString()
                : undefined,
          },
        };
      } catch {
        return {
          data: [],
          meta: {
            hasNextPage: false,
            cursor: undefined,
          },
        };
      }
    }),

  getInvoice: protectedProcedure
    .input(z.string())
    .mutation(async ({ input: orderId, ctx: { teamId } }) => {
      try {
        const order = await api.orders.get({
          id: orderId,
        });

        // Verify the order belongs to this team
        if (order.metadata?.teamId !== teamId) {
          throw new Error("Order not found or not authorized");
        }

        // If invoice doesn't exist, generate it
        if (!order.isInvoiceGenerated) {
          await api.orders.generateInvoice({
            id: orderId,
          });

          // Return status indicating generation is in progress
          return {
            status: "generating",
          };
        }

        // Try to get the invoice
        try {
          const invoice = await api.orders.invoice({
            id: orderId,
          });

          return {
            status: "ready",
            downloadUrl: invoice.url,
          };
        } catch (_invoiceError) {
          // Invoice might still be generating
          return {
            status: "generating",
          };
        }
      } catch (error) {
        logger.error("Failed to get invoice download URL", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw new Error(
          error instanceof Error ? error.message : "Failed to download invoice",
        );
      }
    }),

  checkInvoiceStatus: protectedProcedure
    .input(z.string())
    .query(async ({ input: orderId, ctx: { teamId } }) => {
      try {
        const order = await api.orders.get({
          id: orderId,
        });

        // Verify the order belongs to this team
        if (order.metadata?.teamId !== teamId) {
          throw new Error("Order not found or not authorized");
        }

        if (!order.isInvoiceGenerated) {
          return {
            status: "not_generated",
          };
        }

        try {
          const invoice = await api.orders.invoice({
            id: orderId,
          });

          return {
            status: "ready",
            downloadUrl: invoice.url,
          };
        } catch (_invoiceError) {
          return {
            status: "generating",
          };
        }
      } catch (error) {
        logger.error("Failed to check invoice status", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw new Error(
          error instanceof Error
            ? error.message
            : "Failed to check invoice status",
        );
      }
    }),

  getActiveSubscription: protectedProcedure.query(
    async ({ ctx: { db, teamId } }) => {
      try {
        const customer = await resolvePolarCustomer(db, teamId!);
        const subscriptions = await api.subscriptions.list({
          customerId: customer.id,
        });

        const active = subscriptions.result.items.find(
          (s) =>
            s.metadata?.teamId === teamId &&
            (s.status === "active" ||
              s.status === "past_due" ||
              s.status === "trialing"),
        );

        if (!active) {
          return null;
        }

        const interval = getPlanIntervalByProductId(active.productId);

        return { isYearly: interval === "year" };
      } catch {
        return null;
      }
    },
  ),

  getPortalUrl: protectedProcedure.mutation(async ({ ctx: { db, teamId } }) => {
    const customer = await resolvePolarCustomer(db, teamId!);
    const result = await api.customerSessions.create({
      customerId: customer.id,
    });

    return { url: result.customerPortalUrl };
  }),

  cancelSubscription: protectedProcedure
    .input(cancelSubscriptionSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      const customer = await resolvePolarCustomer(db, teamId!);
      const subscriptions = await api.subscriptions.list({
        customerId: customer.id,
      });

      const teamSubs = subscriptions.result.items.filter(
        (s) => s.metadata?.teamId === teamId,
      );

      const activeSubscription = teamSubs.find(
        (s) =>
          s.status === "active" ||
          s.status === "past_due" ||
          s.status === "trialing",
      );

      if (!activeSubscription) {
        const alreadyCanceled = teamSubs.some(
          (s) => s.status === "canceled" || s.cancelAtPeriodEnd,
        );

        if (alreadyCanceled) {
          logger.info("Subscription already canceled", { teamId });
          return { success: true };
        }

        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No active subscription found",
        });
      }

      if (activeSubscription.cancelAtPeriodEnd) {
        logger.info("Subscription already scheduled for cancellation", {
          teamId,
        });

        return {
          success: true,
        };
      }

      await api.subscriptions.update({
        id: activeSubscription.id,
        subscriptionUpdate: {
          cancelAtPeriodEnd: true,
          customerCancellationReason: input.reason,
          customerCancellationComment: input.comment,
        },
      });

      await updateTeamById(db, {
        id: teamId!,
        data: { canceledAt: new Date().toISOString() },
      });

      logger.info("Subscription canceled", {
        teamId,
        reason: input.reason,
      });

      return { success: true };
    }),

  reactivateSubscription: protectedProcedure.mutation(
    async ({ ctx: { db, teamId } }) => {
      const customer = await resolvePolarCustomer(db, teamId!);
      const subscriptions = await api.subscriptions.list({
        customerId: customer.id,
      });

      const subscription = subscriptions.result.items.find(
        (s) =>
          s.metadata?.teamId === teamId &&
          (s.status === "active" ||
            s.status === "past_due" ||
            s.status === "trialing") &&
          s.cancelAtPeriodEnd,
      );

      if (!subscription) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No canceled subscription found to reactivate",
        });
      }

      await api.subscriptions.update({
        id: subscription.id,
        subscriptionUpdate: {
          cancelAtPeriodEnd: false,
        },
      });

      await updateTeamById(db, {
        id: teamId!,
        data: { canceledAt: null },
      });

      logger.info("Subscription reactivated", { teamId });

      return { success: true };
    },
  ),
});
const __compat_15c226ed8f03=true;
const __sample_15c226ed8f03="admin delete eval innerHTML token password tenantId amount raw SQL child_process";
