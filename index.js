const express = require("express");
const bodyParser = require("body-parser");
const mysql = require("mysql2/promise");

// MySQL connection setup
const pool = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "",
  database: "automated_scheduling",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

const app = express();
app.use(bodyParser.json());

const VISIT_DURATION = 15; // 15 minutes
const VISIT_HOURS_START = 9; // 9 AM
const VISIT_HOURS_END = 19; // 7 PM
const MAX_VISITS_PER_WEEK = 30;

// Helper function to check if a date is a weekend
const isWeekend = (date) => {
  const day = new Date(date).getDay();
  return day === 0 || day === 6;
};

// Helper function to add days to a date
const addDays = (date, days) => {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
};

// Helper function to check availability
const isTimeSlotAvailable = (availability, date, timeSlot) => {
  const dayOfWeek = new Date(date)
    .toLocaleString("en-US", { weekday: "long" })
    .toLowerCase();

  if (availability[dayOfWeek]) {
    return availability[dayOfWeek].some((slot) => {
      const [start, end] = slot.split("-");
      return timeSlot >= start && timeSlot <= end;
    });
  }
  return false;
};

// Route to schedule a visit
app.post("/schedule", async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { apartmentId, tenantId, preferredDate } = req.body;

    // Fetch apartment and runner details
    const [apartments] = await connection.execute(
      "SELECT * FROM Apartments WHERE id = ?",
      [apartmentId]
    );
    const [tenants] = await connection.execute(
      "SELECT * FROM PotentialTenants WHERE id = ?",
      [tenantId]
    );

    if (apartments.length === 0 || tenants.length === 0) {
      return res.status(404).send("Apartment or Tenant not found");
    }

    const apartment = apartments[0];
    const apartmentZone = apartment.zone;

    // Ensure the preferred date is within valid hours and not on a weekend
    if (isWeekend(preferredDate)) {
      return res.status(400).send("Cannot schedule visits on weekends");
    }

    // Fetch runner details
    const [runners] = await connection.execute(
      "SELECT * FROM Runners WHERE id = (SELECT runnerId FROM RunnerApartments WHERE apartmentId = ? LIMIT 1)",
      [apartmentId]
    );

    if (runners.length === 0) {
      return res.status(404).send("Runner not found for this apartment");
    }

    const runner = runners[0];

    // Check if the apartment already has 30 visits in the week
    const startOfWeek = new Date(preferredDate);
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay() + 1); // Get Monday of the week
    const endOfWeek = addDays(startOfWeek, 6); // Get Sunday of the week

    const [weeklyVisits] = await connection.execute(
      "SELECT COUNT(*) as count FROM Visits WHERE apartmentId = ? AND date BETWEEN ? AND ?",
      [
        apartmentId,
        startOfWeek.toISOString().split("T")[0],
        endOfWeek.toISOString().split("T")[0],
      ]
    );

    if (weeklyVisits[0].count >= MAX_VISITS_PER_WEEK) {
      return res.status(400).send("Maximum visits for the week exceeded");
    }

    // Check if the runner has another visit in a different zone on the same day
    const [zoneVisits] = await connection.execute(
      "SELECT * FROM Visits v JOIN Apartments a ON v.apartmentId = a.id WHERE v.runnerId = ? AND v.date = ? AND a.zone != ?",
      [runner.id, preferredDate, apartmentZone]
    );

    if (zoneVisits.length > 0) {
      return res
        .status(400)
        .send(
          `Runner already has a visit scheduled in a different zone on ${preferredDate}`
        );
    }

    // Check availability
    const apartmentAvailability = apartment.availability;
    const runnerAvailability = runner.availability;

    // Find the next available 15-minute slot
    const [visitsOnPreferredDate] = await connection.execute(
      "SELECT * FROM Visits WHERE apartmentId = ? AND date = ?",
      [apartmentId, preferredDate]
    );

    let availableSlot = null;

    for (let hour = VISIT_HOURS_START; hour < VISIT_HOURS_END; hour++) {
      for (let minute = 0; minute < 60; minute += VISIT_DURATION) {
        const timeSlot = `${hour < 10 ? "0" : ""}${hour}:${
          minute < 10 ? "0" : ""
        }${minute}`;
        const visitsInSlot = visitsOnPreferredDate.filter(
          (visit) => visit.timeSlot === timeSlot
        );

        if (
          visitsInSlot.length < 2 &&
          isTimeSlotAvailable(
            apartmentAvailability,
            preferredDate,
            timeSlot,
            "apartment"
          ) &&
          isTimeSlotAvailable(
            runnerAvailability,
            preferredDate,
            timeSlot,
            "runner"
          )
        ) {
          availableSlot = timeSlot;
          break;
        }
      }
      if (availableSlot) break;
    }

    if (!availableSlot) {
      return res.status(400).send("No available slots on the preferred date");
    }

    // Schedule the visit
    const [result] = await connection.execute(
      "INSERT INTO Visits (apartmentId, runnerId, tenantId, date, timeSlot, status) VALUES (?, ?, ?, ?, ?, ?)",
      [
        apartmentId,
        runner.id,
        tenantId,
        preferredDate,
        availableSlot,
        "Scheduled",
      ]
    );

    res.status(201).json({
      id: result.insertId,
      apartmentId,
      runnerId: runner.id,
      tenantId,
      date: preferredDate,
      timeSlot: availableSlot,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send("Internal Server Error");
  } finally {
    connection.release();
  }
});

app.listen(3000, () => {
  console.log("Server is running on port 3000");
});
