# Commerce Topology

The topology follows the commerce hierarchy:
- Shop Owner -> Shop -> Page -> Product.

Categories
- Categories are stored on the product device metadata.
- Use category filtering to compare product performance within a page.

External indicators
- Market Signals page exposes weather + macro metrics.

Graph reasoning tips
- When a user selects a shop owner, include all shops and pages beneath it.
- When a user selects a shop, include all pages and products for that shop.
- When a user selects a page, include all products on that page.
- Products are the atomic telemetry sources; pages/shops/owners aggregate across products.
