export const windowsHandoverRefusal = (key: string, kind: "lane" | "lead" | "pane" = "lane"): string => {
  const instead = kind === "lane"
    ? `close the lane and start a new one (dori close ${key}, then dori launch <new-key> --title T --brief FILE --done CONDITION --no-thread REASON) instead of a handover`
    : kind === "lead"
      ? "close the old lead pane in herdr, start a new lead with omo in a new pane, and update leadPane in your config instead of a handover"
      : "close the pane in herdr and start a new agent with omo instead of freezing or thawing it";
  return `HANDOVER_REFUSED ${key}: freezing panes is not supported on Windows yet; ${instead}`;
};
