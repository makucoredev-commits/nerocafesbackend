export const normalizePhone = (phone, defaultCountryCode = '91') => {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return '';

  // Normalize common Indian mobile inputs to full international form.
  // Examples:
  // 9505749305 -> 919505749305
  // 09505749305 -> 919505749305
  // +919505749305 -> 919505749305
  let normalized = digits;

  if (normalized.startsWith('0') && normalized.length === 11) {
    normalized = normalized.slice(1);
  }
  if (normalized.startsWith('00') && normalized.length > 2) {
    normalized = normalized.slice(2);
  }
  if (normalized.length === 10) {
    normalized = `${defaultCountryCode}${normalized}`;
  }
  if (normalized.length === 13 && normalized.startsWith(`0${defaultCountryCode}`)) {
    normalized = normalized.slice(1);
  }

  return normalized;
};

/**
 * Validate phone number based on country code
 * @param {string} phone - Phone number (can be with or without country code)
 * @param {string} countryCode - ISO country code (e.g., 'IN', 'US')
 * @returns {Object} Validation result { valid: boolean, error?: string }
 */
export const validatePhone = (phone, countryCode = 'IN') => {
  if (!phone) {
    return { valid: false, error: 'Phone number is required' };
  }

  const normalized = normalizePhone(phone);
  const digits = normalized.replace(/\D/g, '');

  // Basic validation: must have at least 10 digits
  if (!digits || digits.length < 10) {
    return { valid: false, error: 'Invalid phone number' };
  }

  // Maximum reasonable length for international numbers
  if (digits.length > 15) {
    return { valid: false, error: 'Phone number is too long' };
  }

  // India-specific validation - more lenient
  if (countryCode === 'IN') {
    // Check if it's an Indian number (starts with 91)
    if (digits.startsWith('91')) {
      const indianNumber = digits.slice(2); // Remove country code
      // Indian mobile numbers typically start with 6, 7, 8, or 9
      // But we'll be lenient and accept any valid 10-digit number
      if (indianNumber.length !== 10) {
        return { valid: false, error: 'Indian mobile numbers must be 10 digits' };
      }
    } else if (digits.length === 10) {
      // Local 10-digit number - accept without strict prefix validation
      // This allows for edge cases and legacy numbers
    } else {
      // For India, if not 10 digits and doesn't start with 91, it's likely invalid
      return { valid: false, error: 'Invalid Indian phone number format' };
    }
  }

  // For non-Indian countries, accept any valid international format
  // Just ensure it's between 10-15 digits
  if (digits.length < 10 || digits.length > 15) {
    return { valid: false, error: 'Phone number must be between 10-15 digits' };
  }

  return { valid: true, normalized };
};

/**
 * Detect country from GPS coordinates
 * @param {number} lat - Latitude
 * @param {number} lng - Longitude
 * @returns {string} ISO country code
 */
export const getCountryFromCoords = (lat, lng) => {
  // Simple bounding box check for India
  // India roughly: lat 8°N to 37°N, lng 68°E to 97°E
  if (lat >= 8 && lat <= 37 && lng >= 68 && lng <= 97) {
    return 'IN';
  }
  
  // For a production app, you'd use a reverse geocoding service
  // like Google Maps API, OpenStreetMap Nominatim, etc.
  // For now, default to international
  return 'INT';
};
