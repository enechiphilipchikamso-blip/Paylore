export const POLICY_EFFECTIVE_DATE = "October 12, 2026";

export function getPolicyLastUpdatedDate() {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(new Date());
}
