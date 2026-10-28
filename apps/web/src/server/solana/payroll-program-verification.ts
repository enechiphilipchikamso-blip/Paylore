import "server-only";

// Next.js entry point. Netlify Functions import "./payroll-program-verification-core" directly because
// the "server-only" marker only resolves inside the Next.js bundler.
export * from "./payroll-program-verification-core";
