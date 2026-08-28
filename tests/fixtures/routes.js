export const routesFixture = [
  {
    departureStation: {
      id: "AAA",
      name: "Alpha",
      country: "Exampleland",
      latitude: 50,
      longitude: 10
    },
    arrivalStations: [
      {
        id: "BBB",
        name: "Bravo",
        country: "Exampleland",
        flightDates: ["2026-08-28", "2026-08-29"]
      },
      {
        id: "DDD",
        name: "Delta",
        country: "Elsewhere",
        flightDates: ["2026-08-28"]
      }
    ]
  },
  {
    departureStation: {
      id: "BBB",
      name: "Bravo",
      country: "Exampleland",
      latitude: 51,
      longitude: 11
    },
    arrivalStations: [
      {
        id: "CCC",
        name: "Charlie",
        country: "Elsewhere",
        flightDates: ["2026-08-28"]
      }
    ]
  },
  {
    departureStation: {
      id: "CCC",
      name: "Charlie",
      country: "Elsewhere",
      latitude: 52,
      longitude: 12
    },
    arrivalStations: [
      { id: "AAA", name: "Alpha", country: "Exampleland" }
    ]
  }
];
