import { logger } from './logger.js';

/**
 * WhatsApp placeholder — integrate Twilio WhatsApp / Meta Cloud API later.
 * Used to send order-ready notifications to customers.
 */
export async function sendWhatsApp(phone, message, extra = {}) {
  logger.info('NOTIFICATION', `whatsapp:placeholder to ${phone}: ${message}`, extra);
  // Integrate WhatsApp provider here
  return { ok: true, placeholder: true };
}
