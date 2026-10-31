// Turns a provider's model list into the tickboxes of the Agents section.

/** Models that share a routing prefix (`corp/…`) become one tickbox with a `prefix/*` rule. */
export function groupModels(models: readonly { id: string; displayName: string; routeProviderId?: string }[]) {
  const groups = new Map<string, { pattern: string; label: string; models: string[] }>();
  for (const model of models) {
    const slash = model.id.indexOf("/");
    if (slash > 0) {
      const prefix = model.id.slice(0, slash);
      const pattern = `${prefix}/*`;
      const group = groups.get(pattern) ?? { pattern, label: model.displayName.split("/")[0]?.trim() || prefix, models: [] };
      group.models.push(model.id);
      groups.set(pattern, group);
    } else {
      groups.set(model.id, { pattern: model.id, label: model.displayName || model.id, models: [model.id] });
    }
  }
  return [...groups.values()];
}
