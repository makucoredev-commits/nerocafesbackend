/**
 * WhatsApp placeholder — integrate Twilio WhatsApp / Meta Cloud API later.
 * Used to send order-ready notifications to customers.
 */
export async function sendWhatsApp(phone, message, extra = {}) {
  console.log('[whatsapp:placeholder]', { phone, message, ...extra });
  // Integrate WhatsApp provider here
  return { ok: true, placeholder: true };
}
