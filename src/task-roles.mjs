// Repository-owned named work roles. Model, harness and effort remain explicit
// in each project's .baa-ton/config.json; these defaults describe role intent only.
export const taskRoles = {
  planning: { description: 'Explore the codebase and produce a plan; do not edit.', effort: 'high' },
  quick: { description: 'Small, bounded work where speed matters most.', effort: 'low' },
  balanced: { description: 'Everyday development with a practical quality/cost balance.', effort: 'medium' },
  implementation: { description: 'Multi-file work requiring careful reasoning and verification.', effort: 'high' },
  sustained: { description: 'Well-specified work that may run for a while.', effort: 'low' },
  review: { description: 'Independently verify correctness, regressions and evidence; do not edit.', effort: 'high' },
  'deep-review': { description: 'Architecture, security or high-risk review; do not edit.', effort: 'max' },
};

export function parseTaskRoleSelection(value, configured = {}) {
  const defaultRoles = Object.keys(configured).length ? Object.keys(configured) : Object.keys(taskRoles);
  const selected = value.trim().toLowerCase() === 'none'
    ? []
    : (value.trim() ? value.split(',').map(role => role.trim()) : defaultRoles);
  if (new Set(selected).size !== selected.length || selected.some(role => !role || (!taskRoles[role] && !configured[role]))) {
    throw new Error(`Choose unique task roles from ${[...new Set([...Object.keys(taskRoles), ...Object.keys(configured)])].join(', ')}, or none.`);
  }
  return selected;
}
