const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN;

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error("❌ Faltan variables de Spotify en el archivo .env");
  process.exit(1);
}

const query = process.argv.slice(2).join(" ");

if (!query) {
  console.error("");
  console.error("❌ Tenés que indicar una canción.");
  console.error("");
  console.error('Ejemplo:');
  console.error('node --env-file=.env test-spotify.mjs "Linkin Park Numb"');
  console.error("");
  process.exit(1);
}

// --------------------------------------------------
// 1. Obtener un nuevo Access Token
// --------------------------------------------------

async function getAccessToken() {
  const basicAuth = Buffer.from(
    `${CLIENT_ID}:${CLIENT_SECRET}`
  ).toString("base64");

  const response = await fetch(
    "https://accounts.spotify.com/api/token",
    {
      method: "POST",

      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },

      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: REFRESH_TOKEN,
      }),
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `No se pudo renovar el token: ${JSON.stringify(data)}`
    );
  }

  return data.access_token;
}

// --------------------------------------------------
// 2. Obtener dispositivos Spotify disponibles
// --------------------------------------------------

async function getDevices(accessToken) {
  const response = await fetch(
    "https://api.spotify.com/v1/me/player/devices",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    const error = await response.text();

    throw new Error(
      `Error obteniendo dispositivos: ${response.status} ${error}`
    );
  }

  const data = await response.json();

  return data.devices;
}

// --------------------------------------------------
// 3. Buscar canción
// --------------------------------------------------

async function searchTrack(accessToken, searchQuery) {
  const params = new URLSearchParams({
    q: searchQuery,
    type: "track",
    limit: "1",
  });

  const response = await fetch(
    `https://api.spotify.com/v1/search?${params}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    const error = await response.text();

    throw new Error(
      `Error buscando canción: ${response.status} ${error}`
    );
  }

  const data = await response.json();

  const track = data.tracks?.items?.[0];

  if (!track) {
    throw new Error(
      `No encontramos ninguna canción para: "${searchQuery}"`
    );
  }

  return track;
}

// --------------------------------------------------
// 4. Reproducir canción
// --------------------------------------------------

async function playTrack(accessToken, deviceId, trackUri) {
  const response = await fetch(
    `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(
      deviceId
    )}`,
    {
      method: "PUT",

      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        uris: [trackUri],
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();

    throw new Error(
      `Error reproduciendo canción: ${response.status} ${error}`
    );
  }
}

// --------------------------------------------------
// MAIN
// --------------------------------------------------

async function main() {
  try {
    console.log("");
    console.log("🚗 Car Music Request");
    console.log("======================================");

    console.log("");
    console.log("🔐 Obteniendo acceso a Spotify...");

    const accessToken = await getAccessToken();

    console.log("✅ Access Token obtenido.");

    // ----------------------------------------------

    console.log("");
    console.log("📱 Buscando dispositivos Spotify...");

    const devices = await getDevices(accessToken);

    if (!devices.length) {
      console.log("");
      console.log("❌ Spotify no encontró ningún dispositivo.");
      console.log("");
      console.log(
        "Abrí Spotify en tu celular y reproducí cualquier canción."
      );
      console.log(
        "Después volvé a ejecutar este comando."
      );

      return;
    }

    console.log("");
    console.log("Dispositivos encontrados:");

    devices.forEach((device, index) => {
      console.log(
        `${index + 1}. ${device.name} | ${device.type} | ${
          device.is_active ? "🟢 ACTIVO" : "⚪ Disponible"
        }`
      );
    });

    // Preferimos dispositivo activo.
    // Si no existe, tomamos el primer dispositivo controlable.

    const device =
      devices.find(
        (d) =>
          d.is_active &&
          !d.is_restricted &&
          d.id
      ) ||
      devices.find(
        (d) =>
          !d.is_restricted &&
          d.id
      );

    if (!device) {
      console.log("");
      console.log(
        "❌ No hay ningún dispositivo Spotify controlable."
      );

      return;
    }

    console.log("");
    console.log(`🎯 Dispositivo seleccionado: ${device.name}`);

    // ----------------------------------------------

    console.log("");
    console.log(`🔎 Buscando: "${query}"`);

    const track = await searchTrack(
      accessToken,
      query
    );

    const artists = track.artists
      .map((artist) => artist.name)
      .join(", ");

    console.log("");
    console.log("🎵 Canción encontrada:");
    console.log(`${track.name} — ${artists}`);

    console.log("");
    console.log("▶ Enviando reproducción a Spotify...");

    await playTrack(
      accessToken,
      device.id,
      track.uri
    );

    console.log("");
    console.log("======================================");
    console.log("✅ REPRODUCCIÓN ENVIADA");
    console.log("======================================");
    console.log("");
    console.log(`🎵 ${track.name}`);
    console.log(`👤 ${artists}`);
    console.log(`📱 ${device.name}`);
    console.log("");
  } catch (error) {
    console.error("");
    console.error("❌ ERROR:");
    console.error(error.message);
    console.error("");
  }
}

main();