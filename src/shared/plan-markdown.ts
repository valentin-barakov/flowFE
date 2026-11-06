export function isCreatePlan(name: string): boolean {
  return name.toLowerCase().replaceAll("_", "").replaceAll("-", "") === "createplan";
}
