/**
 * Minimal mustache-like renderer for message templates: {{customer.name}}, {{appointment.start}}.
 * Unknown variables render as empty string. No code execution, HTML is not escaped (plain-text channels).
 */
export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const value = path.split('.').reduce<unknown>((acc, key) => {
      if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
        return (acc as Record<string, unknown>)[key];
      }
      return undefined;
    }, vars);
    return value === undefined || value === null ? '' : String(value);
  });
}

export function templateVariables(template: string): string[] {
  return [...new Set([...template.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]!))];
}
