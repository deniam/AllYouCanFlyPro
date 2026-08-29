export async function mapConcurrentOrdered(items, concurrency, worker) {
  const values = Array.from(items);
  if (!values.length) return [];
  const results = new Array(values.length);
  let nextIndex = 0;
  let stopped = false;

  async function runWorker() {
    while (!stopped) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      try {
        results[index] = await worker(values[index], index);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  }

  const workerCount = Math.max(1, Math.min(
    values.length,
    Number.isFinite(Number(concurrency)) ? Math.floor(Number(concurrency)) : 1
  ));
  await Promise.all(Array.from({ length: workerCount }, runWorker));
  return results;
}
