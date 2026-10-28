import "server-only";

// Next.js entry point. Netlify Functions import "./rpc-configured" directly because
// the "server-only" marker only resolves inside the Next.js bundler.
export * from "./rpc-configured";
