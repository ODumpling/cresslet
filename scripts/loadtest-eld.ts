// Preloaded into the server by scripts/loadtest-bindings.ts (`node --import`): reports the main
// thread's event-loop delay and utilization over IPC. Not used outside the load test.
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";

// Worker threads inherit the preload; the main thread is the one measured.
if (isMainThread) {
  const h = monitorEventLoopDelay({ resolution: 1 });
  h.enable();
  let elu = performance.eventLoopUtilization();
  let cpu = process.cpuUsage();
  let since = performance.now();

  process.on("message", (m) => {
    if (m === "eld:reset") {
      h.reset();
      elu = performance.eventLoopUtilization();
      cpu = process.cpuUsage();
      since = performance.now();
    } else if (m === "eld:read") {
      const c = process.cpuUsage(cpu);
      process.send!({
        eld: {
          p50: h.percentile(50) / 1e6,
          p99: h.percentile(99) / 1e6,
          max: h.max / 1e6,
          // Share of wall time the main thread was busy.
          elu: performance.eventLoopUtilization(elu).utilization,
          // CPU of the whole process (all threads) per wall second, in cores.
          cores: (c.user + c.system) / 1000 / (performance.now() - since),
        },
      });
    }
  });
}
