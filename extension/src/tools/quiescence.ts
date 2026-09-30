/** A per-wait observer. Only a mutation counter leaves the page; neither
 * text nor attribute values are read or retained. Keep this self-contained:
 * CREATE_QUIESCENCE_PROBE serialises it into the page's execution context. */
export function createQuiescenceObserver(doc: Document): {
  sample: () => number | null;
  stop: () => void;
} {
  let revision = 0;
  let active = true;
  const observer = new MutationObserver((records) => {
    if (records.length) revision++;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    observer.observe(doc, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    // A worker eviction must not leave an observer running indefinitely.
    // All waits are capped at 30 s. Expiration invalidates future samples.
    timer = setTimeout(stop, 31_000);
  } catch (e) {
    // A page-shadowed setTimeout throwing here would otherwise strand a live,
    // timer-less observer: the caller drops a handle that threw.
    observer.disconnect();
    throw e;
  }
  function stop(): void {
    active = false;
    observer.disconnect();
    clearTimeout(timer);
  }
  return {
    sample() {
      if (!active) return null;
      if (observer.takeRecords().length) revision++;
      return revision;
    },
    stop,
  };
}

export const CREATE_QUIESCENCE_PROBE = '(' + createQuiescenceObserver.toString() + ')(document)';
