/**
 * VAPID Key Utility - Run this once to generate keys for Web Push API
 * Usage: node src/utils/vapidKeys.js
 */
import webpush from 'web-push';

// Generate VAPID keys only if not already existing
const vapidKeys = webpush.generateVAPIDKeys();

console.log('\n🔑 === VAPID KEY PAIR GENERATED ===');
console.log('\nAdd these to your .env file:\n');
console.log(`VAPID_PUBLIC_KEY=${vapidKeys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${vapidKeys.privateKey}`);
console.log('\n⚠️  Keep the PRIVATE_KEY secret! Add it to your .env only.');
console.log('📧 VAPID_SUBJECT is typically: mailto:admin@example.com\n');
