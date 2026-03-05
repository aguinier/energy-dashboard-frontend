import { Router } from 'express';
import db from '../config/database.js';

const router = Router();

/**
 * GET /data-freshness/:countryCode
 * Returns the latest timestamp for each data type for a given country
 */
router.get('/:countryCode', (req, res) => {
  try {
    const { countryCode } = req.params;

    // Query latest timestamp from each relevant table
    const latestLoad = db
      .prepare(
        `SELECT MAX(timestamp_utc) as latest FROM energy_load WHERE country_code = ?`
      )
      .get(countryCode) as { latest: string | null } | undefined;

    const latestPrice = db
      .prepare(
        `SELECT MAX(timestamp_utc) as latest FROM energy_price WHERE country_code = ?`
      )
      .get(countryCode) as { latest: string | null } | undefined;

    const latestGeneration = db
      .prepare(
        `SELECT MAX(timestamp_utc) as latest FROM energy_renewable WHERE country_code = ?`
      )
      .get(countryCode) as { latest: string | null } | undefined;

    const latestTSOLoadForecast = db
      .prepare(
        `SELECT MAX(target_timestamp_utc) as latest FROM energy_load_forecast WHERE country_code = ?`
      )
      .get(countryCode) as { latest: string | null } | undefined;

    const latestTSOGenerationForecast = db
      .prepare(
        `SELECT MAX(target_timestamp_utc) as latest FROM energy_generation_forecast WHERE country_code = ?`
      )
      .get(countryCode) as { latest: string | null } | undefined;

    res.json({
      success: true,
      data: {
        load: latestLoad?.latest || null,
        price: latestPrice?.latest || null,
        generation: latestGeneration?.latest || null,
        tsoLoadForecast: latestTSOLoadForecast?.latest || null,
        tsoGenerationForecast: latestTSOGenerationForecast?.latest || null,
      },
    });
  } catch (error) {
    console.error('Error fetching data freshness:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch data freshness',
    });
  }
});

export default router;
