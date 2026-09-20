import { Router } from 'express';
import { Branch } from '../models/Branch.js';
import { OfferBanner } from '../models/OfferBanner.js';
import { MenuItem } from '../models/MenuItem.js';
import { getOrCreateShopSettings } from '../models/ShopSettings.js';
import { branchDbManager } from '../config/branchDbManager.js';
import { resolveBranchContext } from '../middleware/branchContext.js';

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

async function resolveHeroSpotlight(branchId) {
  let ShopSettingsModel = null;
  let MenuItemModel = MenuItem;

  if (branchId) {
    try {
      ShopSettingsModel = await branchDbManager.getBranchModel(branchId, 'ShopSettings');
      MenuItemModel = await branchDbManager.getBranchModel(branchId, 'MenuItem');
    } catch {
      // Fall back to default models
    }
  }

  let s = ShopSettingsModel ? await ShopSettingsModel.findOne() : await getOrCreateShopSettings();
  if (!s) s = await getOrCreateShopSettings();
  const label = (s.heroCardLabel && s.heroCardLabel.trim()) || "Tonight's pick";

  if (s.heroMenuItemId) {
    const m = await MenuItemModel.findById(s.heroMenuItemId).lean();
    if (m && m.available) return { label, item: pickMenuPublic(m) };
  }
  const featured = await MenuItemModel.findOne({ available: true, tags: 'Featured' }).sort({ createdAt: -1 }).lean();
  if (featured) return { label, item: pickMenuPublic(featured) };
  const any = await MenuItemModel.findOne({ available: true }).sort({ createdAt: -1 }).lean();
  return { label, item: pickMenuPublic(any) };
}

const router = Router();

function isRitualBanner(banner) {
  const haystack = `${banner?.title || ''} ${banner?.message || ''}`;
  return /ritual/i.test(haystack);
}

/**
 * GET /api/public/branches
 * Returns all active branches for customer discovery and branch selection.
 * Excludes internal database connection strings.
 */
router.get('/branches', async (_req, res) => {
  try {
    const branches = await branchDbManager.getActiveBranches();
    const sanitized = branches
      .filter((b) => {
        const name = (b.name || '').toLowerCase();
        const dName = (b.displayName || '').toLowerCase();
        return (
          b.status === 'ACTIVE' &&
          !b.isTest &&
          !name.includes('gachibowli') &&
          !dName.includes('gachibowli') &&
          !name.includes('test branch') &&
          b.branchId !== 'branch_003'
        );
      })
      .map((b) => ({
        branchId: b.branchId,
        branchCode: b.branchCode,
        name: b.name,
        displayName: b.displayName || b.name,
        address: b.address,
        city: b.city,
        state: b.state,
        country: b.country,
        latitude: b.latitude,
        longitude: b.longitude,
        serviceRadius: b.serviceRadius || 5000,
        timezone: b.timezone || 'Asia/Kolkata',
        phone: b.phone,
        email: b.email,
        openingHours: b.openingHours,
        status: b.status,
        isDefault: Boolean(b.isDefault),
      }));
    res.json({ branches: sanitized });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/public/branches/:branchId
 */
router.get('/branches/:branchId', async (req, res) => {
  try {
    const b = await branchDbManager.getBranchConfig(req.params.branchId);
    if (!b) {
      return res.status(404).json({ error: 'Branch not found' });
    }
    res.json({
      branch: {
        branchId: b.branchId,
        branchCode: b.branchCode,
        name: b.name,
        displayName: b.displayName || b.name,
        address: b.address,
        city: b.city,
        state: b.state,
        country: b.country,
        latitude: b.latitude,
        longitude: b.longitude,
        serviceRadius: b.serviceRadius || 5000,
        timezone: b.timezone || 'Asia/Kolkata',
        phone: b.phone,
        email: b.email,
        openingHours: b.openingHours,
        status: b.status,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

router.get('/shop', resolveBranchContext, async (req, res) => {
  try {
    let s;
    try {
      const BranchShopSettings = await req.getBranchModel('ShopSettings');
      s = await BranchShopSettings.findOne();
    } catch {
      s = await getOrCreateShopSettings();
    }
    if (!s) s = await getOrCreateShopSettings();

    res.json({
      branchId: req.branchId,
      branchName: req.branch?.name || 'NeroCafes',
      shopOpen: s.shopOpen,
      closedMessage: s.closedMessage,
      contactPhoneNumber: s.contactPhoneNumber || req.branch?.phone || '',
      gstEnabled: s.gstEnabled !== false,
      gstRate: s.gstRate || 5,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Homepage hero spotlight card — label + menu item (admin-configured or Featured fallback). */
router.get('/hero-spotlight', resolveBranchContext, async (req, res) => {
  try {
    const data = await resolveHeroSpotlight(req.branchId);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
