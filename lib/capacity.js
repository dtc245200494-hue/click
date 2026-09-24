export function countActiveWorkers(campaigns) {
  let active = 0;
  for (const campaign of campaigns) {
    const value = Number(campaign?.pool?.active || 0);
    if (Number.isFinite(value) && value > 0) active += value;
  }
  return active;
}

export function getGlobalFreeSlots(campaigns, maxConcurrency) {
  const max = Math.max(1, Number.parseInt(maxConcurrency, 10) || 1);
  return Math.max(0, max - countActiveWorkers(campaigns));
}
