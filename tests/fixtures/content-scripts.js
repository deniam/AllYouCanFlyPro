export const PASS_ID = "12345678-1234-4abc-8def-1234567890ab";

export const dynamicUrlScript = `
  DD_RUM.setUser({ pass_id: "${PASS_ID}", status: "active" });
`;

export const jsonRoutesScript = `
  window.__STATE__ = {"routes":[{"departureStation":{"id":"AAA"},"arrivalStations":[{"id":"BBB","meta":{"tags":["x", "y"]}}]}],"isOneWayFlightsOnly":false};
`;

export const cvoRoutesScript = `
  window.CVO.routes = [{"departureStation":"CCC","arrivalStations":[{"id":"DDD"}]}];
`;
