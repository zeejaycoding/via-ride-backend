const PRICING_PROFILES = {
  PK: {
    label: 'Pakistan',
    currency: 'USD',
    vehicles: {
      car: { baseFare: 0.5, perKm: 0.2, perMin: 0.05, minimumFare: 1 },
      bike: { baseFare: 0.2, perKm: 0.1, perMin: 0.02, minimumFare: 0.5 },
      van: { baseFare: 1.0, perKm: 0.5, perMin: 0.1, minimumFare: 2 },
    },
  },
  EU: {
    label: 'Europe',
    currency: 'USD',
    vehicles: {
      car: { baseFare: 1.0, perKm: 0.5, perMin: 0.1, minimumFare: 2 },
      bike: { baseFare: 0.5, perKm: 0.25, perMin: 0.05, minimumFare: 1 },
      van: { baseFare: 2.0, perKm: 1.0, perMin: 0.2, minimumFare: 4 },
    },
  },
  US: {
    label: 'America',
    currency: 'USD',
    vehicles: {
      car: { baseFare: 1.0, perKm: 0.5, perMin: 0.1, minimumFare: 2 },
      bike: { baseFare: 0.5, perKm: 0.25, perMin: 0.05, minimumFare: 1 },
      van: { baseFare: 2.0, perKm: 1.0, perMin: 0.2, minimumFare: 4 },
    },
  },
};

const COUNTRY_TO_PROFILE = {
  PK: 'PK',
  IN: 'PK',
  BD: 'PK',
  LK: 'PK',
  NP: 'PK',
  EU: 'EU',
  DE: 'EU',
  FR: 'EU',
  ES: 'EU',
  IT: 'EU',
  NL: 'EU',
  BE: 'EU',
  GB: 'EU',
  UK: 'EU',
  US: 'US',
  CA: 'US',
  MX: 'US',
};

const SURGE_LEVELS = {
  normal: 1,
  busy: 1.5,
  peak: 2,
};

const VEHICLE_SPEED_MULTIPLIERS = {
  bike: 0.9,
  car: 1,
  van: 1.2,
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function normalizeKey(value) {
  return (value || '').toString().trim().toUpperCase();
}

function resolveProfile({ countryCode, region } = {}) {
  const regionKey = normalizeKey(region);
  const countryKey = normalizeKey(countryCode);

  if (regionKey === 'EUROPE' || regionKey === 'EUR' || regionKey === 'EU') return PRICING_PROFILES.EU;
  if (regionKey === 'AMERICA' || regionKey === 'AMERICAS' || regionKey === 'NA' || regionKey === 'US') return PRICING_PROFILES.US;
  if (regionKey === 'ASIA' || regionKey === 'APAC' || regionKey === 'PK') return PRICING_PROFILES.PK;

  const profileKey = COUNTRY_TO_PROFILE[countryKey] || 'PK';
  return PRICING_PROFILES[profileKey];
}

function resolveSurgeMultiplier(surge) {
  const surgeKey = normalizeKey(surge).toLowerCase();

  if (!surgeKey) return { level: 'normal', multiplier: SURGE_LEVELS.normal };
  if (SURGE_LEVELS[surgeKey]) return { level: surgeKey, multiplier: SURGE_LEVELS[surgeKey] };

  const numericSurge = Number(surge);
  if (Number.isFinite(numericSurge) && numericSurge > 0) {
    return { level: 'custom', multiplier: numericSurge };
  }

  return { level: 'normal', multiplier: SURGE_LEVELS.normal };
}

function calculateBaseFare(profile, vehicleId, distanceKm, durationMin) {
  const tier = profile.vehicles[vehicleId];

  if (!tier) {
    throw new Error(`Unknown vehicle type: ${vehicleId}`);
  }

  const rawFare = tier.baseFare + tier.perKm * distanceKm + tier.perMin * durationMin;
  return {
    tier,
    rawFare,
    fare: roundMoney(Math.max(tier.minimumFare, rawFare)),
  };
}

function calculateCancellationFee(minutesSinceBooking = 0) {
  const elapsedMinutes = Math.max(0, Number(minutesSinceBooking) || 0);

  if (elapsedMinutes <= 3) {
    return {
      freeUntilMinutes: 3,
      fee: 0,
    };
  }

  const fee = roundMoney(clamp(1 + (elapsedMinutes - 3) * 0.15, 1, 2));
  return {
    freeUntilMinutes: 3,
    fee,
  };
}

function calculateFare({
  vehicleId,
  distanceKm,
  durationMin,
  countryCode,
  region,
  surge,
}) {
  const profile = resolveProfile({ countryCode, region });
  const surgeInfo = resolveSurgeMultiplier(surge);
  const base = calculateBaseFare(profile, vehicleId, Number(distanceKm) || 0, Number(durationMin) || 0);
  const surgedFare = roundMoney(base.fare * surgeInfo.multiplier);

  return {
    countryCode: normalizeKey(countryCode) || null,
    region: profile.label,
    currency: profile.currency,
    surgeLevel: surgeInfo.level,
    surgeMultiplier: surgeInfo.multiplier,
    baseFare: roundMoney(base.tier.baseFare),
    perKm: roundMoney(base.tier.perKm),
    perMin: roundMoney(base.tier.perMin),
    minimumFare: roundMoney(base.tier.minimumFare),
    rawFare: roundMoney(base.rawFare),
    fare: surgedFare,
    breakdown: {
      baseFare: roundMoney(base.tier.baseFare),
      distanceFare: roundMoney(base.tier.perKm * (Number(distanceKm) || 0)),
      timeFare: roundMoney(base.tier.perMin * (Number(durationMin) || 0)),
      minimumFareApplied: base.fare > base.rawFare,
    },
  };
}

function calculateVehicleDuration(durationMin, vehicleId) {
  const multiplier = VEHICLE_SPEED_MULTIPLIERS[vehicleId] || 1;
  return Math.max(1, roundMoney((Number(durationMin) || 0) * multiplier));
}

module.exports = {
  calculateCancellationFee,
  calculateFare,
  calculateVehicleDuration,
  resolveProfile,
  resolveSurgeMultiplier,
};