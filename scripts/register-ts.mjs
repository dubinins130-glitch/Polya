import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.{1,2}\//.test(specifier) && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith(".ts")) {
      return nextResolve(specifier + ".ts", context);
    }
    return nextResolve(specifier, context);
  }
});
