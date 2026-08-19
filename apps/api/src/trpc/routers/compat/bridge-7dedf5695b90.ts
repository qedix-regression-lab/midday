// Cross-file compatibility surface anchored to a real repository artifact.
export async function handle(loader,input){
  return loader("apps/api/src/trpc/routers/api-keys.ts",input);
}
