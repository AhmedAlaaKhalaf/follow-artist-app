/**
 * Data for the admin home dashboard. Every part degrades to empty values so
 * the home page always renders.
 */

import db from "../db.server";
import { followTagForHandle } from "./artist-follow-constants";

const ARTISTS_QUERY = `#graphql
  query DashboardArtists($type: String!) {
    metaobjects(type: $type, first: 50) {
      nodes {
        id
        handle
        displayName
        image: field(key: "image") {
          reference {
            ... on MediaImage { image { url(transform: { maxWidth: 80, maxHeight: 80 }) } }
          }
        }
      }
    }
  }
`;

const NODES_QUERY = `#graphql
  query DashboardProducts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        featuredMedia { preview { image { url(transform: { maxWidth: 80, maxHeight: 80 }) } } }
      }
    }
  }
`;

async function gql(admin, query, variables) {
  const response = await admin.graphql(query, { variables });
  const body = await response.json();
  if (body?.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join("; "));
  }
  return body.data;
}

const SAFE_HANDLE = /^[a-z0-9][a-z0-9-]*$/;

async function followerCounts(admin, artists) {
  const usable = artists.filter((a) => SAFE_HANDLE.test(a.handle));
  if (!usable.length) return new Map();
  const fields = usable
    .map((a, i) => `a${i}: customersCount(query: "tag:'${followTagForHandle(a.handle)}'") { count }`)
    .join("\n");
  const data = await gql(admin, `query DashboardFollowerCounts {\n${fields}\n}`, {});
  return new Map(usable.map((a, i) => [a.id, data?.[`a${i}`]?.count ?? 0]));
}

export async function loadDashboard(admin, shop, artistType) {
  const result = {
    artistCount: 0,
    followCount: 0,
    emailsSent: 0,
    announcements: 0,
    topArtists: [],
    recentAnnouncements: [],
  };

  let artists = [];
  if (artistType) {
    try {
      const data = await gql(admin, ARTISTS_QUERY, { type: artistType });
      artists = (data?.metaobjects?.nodes ?? []).map((n) => ({
        id: n.id,
        handle: n.handle,
        name: n.displayName || n.handle,
        imageUrl: n.image?.reference?.image?.url ?? null,
        followers: 0,
      }));
      result.artistCount = artists.length;
    } catch (error) {
      console.error("[dashboard] artists query failed", { message: error?.message });
    }
  }

  try {
    const counts = await followerCounts(admin, artists);
    for (const artist of artists) artist.followers = counts.get(artist.id) ?? 0;
    result.followCount = artists.reduce((sum, a) => sum + a.followers, 0);
  } catch (error) {
    console.error("[dashboard] follower counts failed", { message: error?.message });
  }

  result.topArtists = [...artists]
    .sort((a, b) => b.followers - a.followers || a.name.localeCompare(b.name))
    .slice(0, 5);

  try {
    const [totals, recent] = await Promise.all([
      db.productEmailLog.aggregate({
        where: { shop, status: "sent" },
        _sum: { recipients: true },
        _count: { _all: true },
      }),
      db.productEmailLog.findMany({
        where: { shop, status: "sent" },
        orderBy: { createdAt: "desc" },
        take: 5,
      }),
    ]);
    result.emailsSent = totals._sum.recipients ?? 0;
    result.announcements = totals._count._all ?? 0;

    let products = new Map();
    if (recent.length) {
      try {
        const data = await gql(admin, NODES_QUERY, { ids: recent.map((r) => r.productGid) });
        products = new Map((data?.nodes ?? []).filter(Boolean).map((p) => [p.id, p]));
      } catch (error) {
        console.error("[dashboard] product lookup failed", { message: error?.message });
      }
    }
    const artistsById = new Map(artists.map((a) => [a.id, a]));
    result.recentAnnouncements = recent.map((r) => {
      const product = products.get(r.productGid);
      return {
        id: r.id,
        productTitle: product?.title || "Deleted product",
        productId: r.productGid.split("/").pop(),
        imageUrl: product?.featuredMedia?.preview?.image?.url ?? null,
        artistName: artistsById.get(r.artistGid)?.name || "—",
        recipients: r.recipients,
        sentAt: r.createdAt.toISOString(),
      };
    });
  } catch (error) {
    console.error("[dashboard] email stats failed", { message: error?.message });
  }

  return result;
}
