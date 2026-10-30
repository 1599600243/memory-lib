function text(value) {
  const normalized = String(value ?? "").trim();
  return normalized || "-";
}

function rankedEntries(counts, label) {
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([name, count]) => ({ [label]: name, count }));
}

/**
 * Aggregate audit events by framework / agent / role without mutating input.
 * Invalid timestamps still count toward calls, but do not invent sample bounds.
 */
export function aggregateAgents(events) {
  const sample = Array.isArray(events) ? events : [];
  const groups = new Map();
  let denied = 0;
  let oldest = Infinity;
  let newest = -Infinity;

  for (const event of sample) {
    const hasIdentity = [event?.framework, event?.agent, event?.role]
      .some((value) => String(value ?? "").trim());
    const framework = text(event?.framework);
    const agent = hasIdentity ? text(event?.agent)
      : event?.allow === false ? "未认证/被拒请求" : "系统事件（无身份）";
    const role = text(event?.role);
    const key = JSON.stringify([framework, agent, role]);
    const group = groups.get(key) ?? {
      framework, agent, role, calls: 0, denied: 0, lastMs: -Infinity,
      actions: new Map(), deniedActions: new Map(), channels: new Map(),
    };
    const action = text(event?.action);
    const channel = text(event?.channel);
    const timestamp = Date.parse(event?.ts);

    group.calls += 1;
    group.actions.set(action, (group.actions.get(action) ?? 0) + 1);
    group.channels.set(channel, (group.channels.get(channel) ?? 0) + 1);
    if (event?.allow === false) {
      group.denied += 1;
      denied += 1;
      group.deniedActions.set(action, (group.deniedActions.get(action) ?? 0) + 1);
    }
    if (Number.isFinite(timestamp)) {
      oldest = Math.min(oldest, timestamp);
      newest = Math.max(newest, timestamp);
      group.lastMs = Math.max(group.lastMs, timestamp);
    }
    groups.set(key, group);
  }

  const rows = [...groups.values()]
    .sort((left, right) => right.calls - left.calls
      || left.framework.localeCompare(right.framework)
      || left.agent.localeCompare(right.agent)
      || left.role.localeCompare(right.role))
    .map((group) => ({
      framework: group.framework,
      agent: group.agent,
      role: group.role,
      calls: group.calls,
      denied: group.denied,
      last: Number.isFinite(group.lastMs) ? new Date(group.lastMs).toISOString() : null,
      topActions: rankedEntries(group.actions, "action").slice(0, 3),
      deniedActions: rankedEntries(group.deniedActions, "action"),
      channels: rankedEntries(group.channels, "channel"),
    }));

  return {
    total: sample.length,
    denied,
    from: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
    to: Number.isFinite(newest) ? new Date(newest).toISOString() : null,
    rows,
  };
}
