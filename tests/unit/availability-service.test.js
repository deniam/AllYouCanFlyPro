import { describe, expect, it, vi } from "vitest";
import { createAvailabilityService } from "../../src/domain/search/availability-service.js";
import { AvailabilityState } from "../../src/infrastructure/cache-repository.js";

describe("availability service", () => {
  it("coalesces the same segment/date regardless of paired return date", async () => {
    const gate = Promise.resolve({
      state: AvailabilityState.AVAILABLE,
      source: "network",
      flights: [{ key: "shared" }]
    });
    const loadFlights = vi.fn(() => gate);
    const service = createAvailabilityService({ loadFlights });
    const scope = service.createScope({ preferredReturnDates: ["2026-09-03"] });
    const [first, second] = await Promise.all([
      scope.resolve({ origin: "AAA", destination: "BBB", date: "2026-09-01", arrivalDate: "2026-09-04" }),
      scope.resolve({ origin: "AAA", destination: "BBB", date: "2026-09-01", arrivalDate: "2026-09-05" })
    ]);
    expect(loadFlights).toHaveBeenCalledOnce();
    expect(first.flights).toEqual(second.flights);
  });

  it("keeps transient failures unknown and exposes them for retry", async () => {
    const service = createAvailabilityService({
      loadFlights: vi.fn().mockRejectedValue(new Error("timeout"))
    });
    const scope = service.createScope();
    const outcome = await scope.resolve({ origin: "AAA", destination: "BBB", date: "2026-09-01" });
    expect(outcome.state).toBe(AvailabilityState.UNKNOWN);
    expect(scope.getFailed()).toHaveLength(1);
  });

  it("prunes excluded and date-invalid segments without network", async () => {
    const loadFlights = vi.fn();
    const service = createAvailabilityService({
      loadFlights,
      isRouteExcluded: () => true
    });
    const scope = service.createScope();
    const outcome = await scope.resolve({ origin: "AAA", destination: "BBB", date: "2026-09-01" });
    expect(outcome.state).toBe(AvailabilityState.UNAVAILABLE);
    expect(loadFlights).not.toHaveBeenCalled();
  });
});
