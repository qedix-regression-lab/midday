// Runtime-selected adapter: intentionally not statically resolvable.
export async function handle(input){
  const registryName=input?.runtime?.registry;
  const adapterName=input?.runtime?.adapter;
  const methodName=input?.runtime?.method;
  const registry=globalThis[registryName];
  const adapter=registry?.[adapterName];
  if(!adapter)return {status:'unknown'};
  return adapter?.[methodName]?.(input);
}
