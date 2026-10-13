exports.handler = async function(event) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "ODDS_API_KEY is not configured in Netlify environment variables." })
    };
  }

  const params = event.queryStringParameters || {};
  const sport = params.sport || "baseball_mlb";
  const regions = params.regions || "us";
  const markets = params.markets || "h2h,spreads,totals";
  const oddsFormat = params.oddsFormat || "american";
  const dateFormat = params.dateFormat || "iso";

  // Input validation: this endpoint spends the site's Odds API credits, so only allow known shapes.
  const okList = (value, allowed) => value.split(",").every((v) => allowed.includes(v));
  if (!/^[a-z0-9_]{2,64}$/.test(sport) ||
      !okList(markets, ["h2h", "spreads", "totals", "outrights", "h2h_lay", "outrights_lay"]) ||
      !okList(regions, ["us", "us2", "us_dfs", "us_ex", "uk", "eu", "au"]) ||
      !["american", "decimal"].includes(oddsFormat) || !["iso", "unix"].includes(dateFormat)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid parameters." }) };
  }

  const url = new URL(`https://api.the-odds-api.com/v4/sports/${sport}/odds/`);
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("regions", regions);
  url.searchParams.set("markets", markets);
  url.searchParams.set("oddsFormat", oddsFormat);
  url.searchParams.set("dateFormat", dateFormat);

  try {
    const response = await fetch(url.toString());
    const text = await response.text();
    return {
      statusCode: response.status,
      headers,
      body: text || JSON.stringify([])
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Failed to fetch odds.", detail: error.message })
    };
  }
};
