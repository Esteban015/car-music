import http from "node:http";
import crypto from "node:crypto";

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI;

const PORT = 8888;

if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
  console.error("❌ Faltan variables de entorno de Spotify.");
  process.exit(1);
}

let expectedState = null;

const SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
].join(" ");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // Iniciar login
  if (url.pathname === "/login") {
    expectedState = crypto.randomBytes(16).toString("hex");

    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      scope: SCOPES,
      redirect_uri: REDIRECT_URI,
      state: expectedState,
      show_dialog: "true",
    });

    const spotifyAuthUrl =
      `https://accounts.spotify.com/authorize?${params.toString()}`;

    res.writeHead(302, {
      Location: spotifyAuthUrl,
    });

    res.end();
    return;
  }

  // Callback de Spotify
  if (url.pathname === "/callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      res.writeHead(400, {
        "Content-Type": "text/plain; charset=utf-8",
      });

      res.end(`Spotify devolvió un error: ${error}`);
      return;
    }

    if (!state || state !== expectedState) {
      res.writeHead(400, {
        "Content-Type": "text/plain; charset=utf-8",
      });

      res.end("State inválido. Autenticación cancelada.");
      return;
    }

    if (!code) {
      res.writeHead(400, {
        "Content-Type": "text/plain; charset=utf-8",
      });

      res.end("Spotify no devolvió authorization code.");
      return;
    }

    try {
      const basicAuth = Buffer.from(
        `${CLIENT_ID}:${CLIENT_SECRET}`
      ).toString("base64");

      const tokenResponse = await fetch(
        "https://accounts.spotify.com/api/token",
        {
          method: "POST",

          headers: {
            Authorization: `Basic ${basicAuth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },

          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: REDIRECT_URI,
          }),
        }
      );

      const tokens = await tokenResponse.json();

      if (!tokenResponse.ok) {
        console.error("❌ Spotify Token Error:", tokens);

        res.writeHead(500, {
          "Content-Type": "text/plain; charset=utf-8",
        });

        res.end("No se pudo obtener el token.");
        return;
      }

      console.log("\n======================================");
      console.log("✅ AUTENTICACIÓN SPOTIFY CORRECTA");
      console.log("======================================");

      console.log("\nRefresh Token:");
      console.log(tokens.refresh_token);

      console.log("\nScopes:");
      console.log(tokens.scope);

      console.log("\nExpira en:");
      console.log(`${tokens.expires_in} segundos`);

      console.log("\n⚠️ No compartas el Refresh Token.");
      console.log("======================================\n");

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
      });

      res.end(`
        <!DOCTYPE html>
        <html lang="es">
          <head>
            <meta charset="UTF-8">
            <title>Spotify conectado</title>
          </head>

          <body style="
            font-family: Arial, sans-serif;
            text-align: center;
            padding-top: 80px;
          ">
            <h1>✅ Spotify conectado correctamente</h1>

            <p>
              Ya podés cerrar esta ventana.
            </p>

            <p>
              El Refresh Token está disponible
              únicamente en la terminal de VS Code.
            </p>
          </body>
        </html>
      `);

      return;

    } catch (error) {
      console.error(error);

      res.writeHead(500, {
        "Content-Type": "text/plain; charset=utf-8",
      });

      res.end("Error interno.");
      return;
    }
  }

  // Página inicial
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
  });

  res.end(`
    <!DOCTYPE html>
    <html lang="es">
      <head>
        <meta charset="UTF-8">
        <title>Car Music Request</title>
      </head>

      <body style="
        font-family: Arial, sans-serif;
        text-align: center;
        padding-top: 80px;
      ">

        <h1>🚗 Car Music Request</h1>

        <p>
          Conectá tu cuenta de Spotify para continuar.
        </p>

        <a
          href="/login"
          style="
            display: inline-block;
            padding: 15px 30px;
            background: #1DB954;
            color: white;
            text-decoration: none;
            border-radius: 30px;
            font-weight: bold;
          "
        >
          Conectar Spotify
        </a>

      </body>
    </html>
  `);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("");
  console.log("🚗 Car Music Request");
  console.log("-------------------------------");
  console.log(`Servidor iniciado en:`);
  console.log(`http://127.0.0.1:${PORT}`);
  console.log("");
  console.log("Abrí esa dirección en tu navegador.");
  console.log("");
});