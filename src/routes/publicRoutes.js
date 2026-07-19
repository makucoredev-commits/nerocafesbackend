import { Router } from 'express';
import { OfferBanner } from '../models/OfferBanner.js';
import { MenuItem } from '../models/MenuItem.js';
import { getOrCreateShopSettings } from '../models/ShopSettings.js';

function pickMenuPublic(m) {
  if (!m) return null;
  return {
    _id: m._id,
    name: m.name,
    price: m.price,
    category: m.category,
    image: m.image || '',
    tags: m.tags || [],
  };
}

async function resolveHeroSpotlight() {
  const s = await getOrCreateShopSettings();
  const label = (s.heroCardLabel && s.heroCardLabel.trim()) || "Tonight's pick";

  if (s.heroMenuItemId) {
    const m = await MenuItem.findById(s.heroMenuItemId).lean();
    if (m && m.available) return { label, item: pickMenuPublic(m) };
  }
  const featured = await MenuItem.findOne({ available: true, tags: 'Featured' }).sort({ createdAt: -1 }).lean();
  if (featured) return { label, item: pickMenuPublic(featured) };
  const any = await MenuItem.findOne({ available: true }).sort({ createdAt: -1 }).lean();
  return { label, item: pickMenuPublic(any) };
}

const router = Router();

function isRitualBanner(banner) {
  const haystack = `${banner?.title || ''} ${banner?.message || ''}`;
  return /ritual/i.test(haystack);
}

router.get('/banner', async (_req, res) => {
  try {
    const banner = await OfferBanner.findOne({ active: true }).sort({ createdAt: -1 });
    const safeBanner = isRitualBanner(banner) ? null : banner;
    res.json({ banner: safeBanner });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/banners', async (_req, res) => {
  try {
    const banners = await OfferBanner.find({ active: true }).sort({ createdAt: -1 }).limit(6);
    const safeBanners = (banners || []).filter((banner) => !isRitualBanner(banner));
    res.json({ banners: safeBanners });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/shop', async (_req, res) => {
  try {
    const s = await getOrCreateShopSettings();
    res.json({ 
      shopOpen: s.shopOpen, 
      closedMessage: s.closedMessage,
      contactPhoneNumber: s.contactPhoneNumber
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Homepage hero spotlight card — label + menu item (admin-configured or Featured fallback). */
router.get('/hero-spotlight', async (_req, res) => {
  try {
    const data = await resolveHeroSpotlight();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
