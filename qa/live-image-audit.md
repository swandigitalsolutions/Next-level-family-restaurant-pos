# Live Image Audit

Captured from the authenticated Food Billing page in the live preview on 2026-08-26.

- Food cards rendered: 78.
- Failed image loads observed immediately after the page render: 0.
- Images fully loaded at the measurement moment: 16; remaining images were still loading because the page eagerly requested the full All Items gallery.
- Unique image source URLs: 68 across 78 cards, confirming repeated assets remain in the map.
- The largest loaded natural dimensions include five AI images at 2176x1632, a 5472x3648 Jalebi photo, 3000x4500 Soft Drink, and several 2560px square/landscape images.
- Local audit found 204 image files totaling approximately 85 MB across the active asset directories; 11 mapped files exceeded 350 KB, with the five AI images each above 5 MB.
- No corrupt files and no missing mapped files were found on disk.
- The live Food Billing page contains 12 table cards and the table workflow remains visible.

Optimization priorities: create small WebP derivatives, stop eagerly downloading all 78 images, add native lazy loading/fetch priority, use a resilient fallback, and keep the existing map and item names unchanged.
