/**
 * Merchant-facing summary of `getConfigStatus()` for the admin pages.
 * Client-safe (no server imports).
 */
export function setupChecks(status) {
  const artist = status?.artistMetaobject || {};
  const product = status?.productArtistMetafield || {};
  const customer = status?.customerFollowedMetafield || {};

  const checks = [
    {
      id: "artist",
      label: "Artist profiles",
      description: "Artists your customers can follow.",
      ok: Boolean(artist.ok && artist.usingAppArtist),
    },
    {
      id: "pages",
      label: "Artist pages",
      description: "Each artist has a public page on your Online Store.",
      ok: Boolean(artist.optionsReady),
    },
    {
      id: "product",
      label: "Product artist field",
      description: "Lets you link each product to its artist.",
      ok: Boolean(product.ok && product.pointsAtAppArtist),
    },
    {
      id: "customer",
      label: "Customer follow list",
      description: "Remembers which artists each customer follows.",
      ok: Boolean(customer.ok && customer.pointsAtAppArtist),
    },
  ];

  return { checks, ready: checks.every((c) => c.ok) };
}
