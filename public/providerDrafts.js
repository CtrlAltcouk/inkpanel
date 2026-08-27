const defaults = { calendar: 'ical', todo: 'local' };

export function providerOf(type, config) { return defaults[type] ? config.provider ?? defaults[type] : null; }

export function providerDraftState(widgets) {
  const result = {};
  for (const widget of widgets) {
    const provider = providerOf(widget.type, widget.config);
    if (provider) (result[widget.type] ??= {})[provider] = structuredClone(widget);
  }
  return result;
}

/** Only an explicit provider switch upgrades the active widget to V2. */
export function switchProviderDraft(slot, type, provider, emptyConfig) {
  const current = slot.drafts[type];
  slot.providerDrafts ??= {};
  const drafts = slot.providerDrafts[type] ??= {};
  drafts[providerOf(type, current)] = { type, version: slot.versions[type], config: structuredClone(current) };
  slot.drafts[type] = { ...structuredClone(drafts[provider]?.config ?? emptyConfig), provider };
  slot.versions[type] = 2;
}

/** Active config first; inactive providers follow without replacing its version. */
export function rememberedProviderDrafts(slot) {
  return Object.entries(slot.drafts).flatMap(([type, config]) => [
    { type, version: slot.versions[type], config: structuredClone(config) },
    ...Object.entries(slot.providerDrafts?.[type] ?? {})
      .filter(([provider]) => provider !== providerOf(type, config))
      .map(([, widget]) => structuredClone(widget)),
  ]);
}
