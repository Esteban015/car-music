import {
  DurableObject
} from "cloudflare:workers";

const REQUESTS_ON_HOURS = 12;
const ADMIN_SESSION_HOURS = 8;
const MAX_QUERY_LENGTH = 100;
const MAX_BODY_BYTES = 2048;

/*
|--------------------------------------------------------------------------
| DURABLE OBJECT - MUSIC GUARD
|--------------------------------------------------------------------------
|
| Estado fuertemente consistente para un único vehículo.
|
| Controla:
|
| - ON / OFF
| - autoapagado
| - 1 canción cada 10 segundos
| - 3 solicitudes/minuto por navegador
| - 5 intentos admin/minuto
|
|--------------------------------------------------------------------------
*/

export class MusicGuard
  extends DurableObject {

  constructor(
    ctx,
    env
  ) {

    super(
      ctx,
      env
    );

    this.ctx =
      ctx;

  }


  /*
  |--------------------------------------------------------------------------
  | ESTADO DEL SERVICIO
  |--------------------------------------------------------------------------
  */

  async getStatus() {

    const enabledUntil =
      Number(
        (
          await this.ctx.storage.get(
            "enabledUntil"
          )
        ) || 0
      );


    const enabled =
      enabledUntil >
      Date.now();


    return {

      enabled,

      enabledUntil:
        enabled
          ? enabledUntil
          : null

    };

  }


  /*
  |--------------------------------------------------------------------------
  | ACTIVAR / DESACTIVAR
  |--------------------------------------------------------------------------
  */

  async setEnabled(
    enabled
  ) {

    if (enabled) {

      const enabledUntil =
        Date.now() +
        REQUESTS_ON_HOURS *
        60 *
        60 *
        1000;


      await this.ctx.storage.put(
        "enabledUntil",
        enabledUntil
      );


      /*
      | Cuando iniciamos una nueva sesión,
      | permitimos inmediatamente
      | la primera canción.
      */

      await this.ctx.storage.put(
        "lastGlobalPlayAt",
        0
      );


      const feedbackSessionId =
        Date.now().toString();


        await this.ctx.storage.put(
        "feedbackSessionId",
        feedbackSessionId
        );

      return {

        enabled:
          true,

        enabledUntil

      };

    }


    /*
    |--------------------------------------------------------------------------
    | OFF
    |--------------------------------------------------------------------------
    */

    await this.ctx.storage.put(
      "enabledUntil",
      0
    );


    await this.ctx.storage.put(
      "lastGlobalPlayAt",
      0
    );


    return {

      enabled:
        false,

      enabledUntil:
        null

    };

  }


  /*
  |--------------------------------------------------------------------------
  | VALIDAR PEDIDO
  |--------------------------------------------------------------------------
  */

  async checkMusicRequest(
    clientId
  ) {

    const now =
      Date.now();


    /*
    |--------------------------------------------------------------------------
    | ¿ESTÁ HABILITADO?
    |--------------------------------------------------------------------------
    */

    const enabledUntil =
      Number(
        (
          await this.ctx.storage.get(
            "enabledUntil"
          )
        ) || 0
      );


    if (
      enabledUntil <=
      now
    ) {

      return {

        allowed:
          false,

        reason:
          "DISABLED"

      };

    }


    /*
    |--------------------------------------------------------------------------
    | COOLDOWN GLOBAL
    |--------------------------------------------------------------------------
    */

    const lastGlobalPlayAt =
      Number(
        (
          await this.ctx.storage.get(
            "lastGlobalPlayAt"
          )
        ) || 0
      );


    const globalElapsed =
      now -
      lastGlobalPlayAt;


    if (
      globalElapsed <
      10000
    ) {

      return {

        allowed:
          false,

        reason:
          "GLOBAL_COOLDOWN",

        retryAfterMs:
          10000 -
          globalElapsed

      };

    }


    /*
    |--------------------------------------------------------------------------
    | RATE LIMIT PASAJERO
    |--------------------------------------------------------------------------
    */

    const passengerKey =
      "passenger:" +
      clientId;


    const stored =
      (
        await this.ctx.storage.get(
          passengerKey
        )
      ) || [];


    /*
    | Solamente conservamos requests
    | de los últimos 60 segundos.
    */

    const recent =
      stored.filter(
        timestamp =>
          now -
          timestamp <
          60000
      );


    if (
      recent.length >=
      3
    ) {

      const oldest =
        recent[0];


      return {

        allowed:
          false,

        reason:
          "PASSENGER_LIMIT",

        retryAfterMs:
          Math.max(
            1000,
            60000 -
            (
              now -
              oldest
            )
          )

      };

    }


    /*
    |--------------------------------------------------------------------------
    | RESERVAMOS EL TURNO
    |--------------------------------------------------------------------------
    |
    | El Durable Object mantiene este estado
    | fuertemente consistente.
    |
    |--------------------------------------------------------------------------
    */

    recent.push(
      now
    );


    await this.ctx.storage.put(
      passengerKey,
      recent
    );


    await this.ctx.storage.put(
      "lastGlobalPlayAt",
      now
    );


    return {

      allowed:
        true

    };

  }


  /*
  |--------------------------------------------------------------------------
  | ADMIN LOGIN LIMIT
  |--------------------------------------------------------------------------
  */

  async checkAdminLogin() {

    const now =
      Date.now();


    const stored =
      (
        await this.ctx.storage.get(
          "adminLoginAttempts"
        )
      ) || [];


    const recent =
      stored.filter(
        timestamp =>
          now -
          timestamp <
          60000
      );


    if (
      recent.length >=
      5
    ) {

      return {

        allowed:
          false,

        retryAfterMs:
          Math.max(
            1000,
            60000 -
            (
              now -
              recent[0]
            )
          )

      };

    }


    recent.push(
      now
    );


    await this.ctx.storage.put(
      "adminLoginAttempts",
      recent
    );


    return {

      allowed:
        true

    };

  }


  /*
  |--------------------------------------------------------------------------
  | LOGIN CORRECTO → LIMPIAR INTENTOS
  |--------------------------------------------------------------------------
  */

  async clearAdminAttempts() {

    await this.ctx.storage.delete(
      "adminLoginAttempts"
    );


    return true;

  }

  /*
    |--------------------------------------------------------------------------
    | GUARDAR FEEDBACK
    |--------------------------------------------------------------------------
    */

    async submitFeedback(
    clientId,
    vote
    ) {

    const state =
        await this.getStatus();


    if (!state.enabled) {

        return {
        accepted: false,
        reason: "DISABLED"
        };

    }


    const sessionId =
        (
        await this.ctx.storage.get(
            "feedbackSessionId"
        )
        ) || "default";


    const voteKey =
        `feedbackVote:${sessionId}:${clientId}`;


    /*
    |--------------------------------------------------------------------------
    | UN VOTO POR NAVEGADOR / SESIÓN
    |--------------------------------------------------------------------------
    */

    const existingVote =
        await this.ctx.storage.get(
        voteKey
        );


    if (existingVote) {

        return {
        accepted: false,
        reason: "ALREADY_VOTED"
        };

    }


    const now =
        Date.now();


    /*
    |--------------------------------------------------------------------------
    | GUARDAR VOTO INDIVIDUAL
    |--------------------------------------------------------------------------
    */

    await this.ctx.storage.put(
        voteKey,
        {
        vote,
        timestamp: now
        }
    );


    /*
    |--------------------------------------------------------------------------
    | CONTADORES GLOBALES
    |--------------------------------------------------------------------------
    */

    const total =
        Number(
        (
            await this.ctx.storage.get(
            "feedbackTotal"
            )
        ) || 0
        );


    const positive =
        Number(
        (
            await this.ctx.storage.get(
            "feedbackPositive"
            )
        ) || 0
        );


    const negative =
        Number(
        (
            await this.ctx.storage.get(
            "feedbackNegative"
            )
        ) || 0
        );


    await this.ctx.storage.put(
        "feedbackTotal",
        total + 1
    );


    if (
        vote === "positive"
    ) {

        await this.ctx.storage.put(
        "feedbackPositive",
        positive + 1
        );

    }


    if (
        vote === "negative"
    ) {

        await this.ctx.storage.put(
        "feedbackNegative",
        negative + 1
        );

    }


    /*
    |--------------------------------------------------------------------------
    | CONTADORES SESIÓN ACTUAL
    |--------------------------------------------------------------------------
    */

    const sessionTotalKey =
        `feedbackSessionTotal:${sessionId}`;


    const sessionPositiveKey =
        `feedbackSessionPositive:${sessionId}`;


    const sessionNegativeKey =
        `feedbackSessionNegative:${sessionId}`;


    const sessionTotal =
        Number(
        (
            await this.ctx.storage.get(
            sessionTotalKey
            )
        ) || 0
        );


    await this.ctx.storage.put(
        sessionTotalKey,
        sessionTotal + 1
    );


    if (
        vote === "positive"
    ) {

        const value =
        Number(
            (
            await this.ctx.storage.get(
                sessionPositiveKey
            )
            ) || 0
        );


        await this.ctx.storage.put(
        sessionPositiveKey,
        value + 1
        );

    }


    if (
        vote === "negative"
    ) {

        const value =
        Number(
            (
            await this.ctx.storage.get(
                sessionNegativeKey
            )
            ) || 0
        );


        await this.ctx.storage.put(
        sessionNegativeKey,
        value + 1
        );

    }


    return {
        accepted: true
    };

    }


    /*
    |--------------------------------------------------------------------------
    | ESTADÍSTICAS FEEDBACK
    |--------------------------------------------------------------------------
    */

    async getFeedbackStats() {

    const sessionId =
        (
        await this.ctx.storage.get(
            "feedbackSessionId"
        )
        ) || "default";


    const total =
        Number(
        (
            await this.ctx.storage.get(
            "feedbackTotal"
            )
        ) || 0
        );


    const positive =
        Number(
        (
            await this.ctx.storage.get(
            "feedbackPositive"
            )
        ) || 0
        );


    const negative =
        Number(
        (
            await this.ctx.storage.get(
            "feedbackNegative"
            )
        ) || 0
        );


    const sessionTotal =
        Number(
        (
            await this.ctx.storage.get(
            `feedbackSessionTotal:${sessionId}`
            )
        ) || 0
        );


    const sessionPositive =
        Number(
        (
            await this.ctx.storage.get(
            `feedbackSessionPositive:${sessionId}`
            )
        ) || 0
        );


    const sessionNegative =
        Number(
        (
            await this.ctx.storage.get(
            `feedbackSessionNegative:${sessionId}`
            )
        ) || 0
        );


    const satisfaction =
        total > 0
        ? Math.round(
            (
                positive /
                total
            ) *
            100
            )
        : 0;


    return {

        total,
        positive,
        negative,
        satisfaction,

        currentSession: {
        total:
            sessionTotal,

        positive:
            sessionPositive,

        negative:
            sessionNegative
        }

    };

    }

}



/*
|--------------------------------------------------------------------------
| OBTENER MUSIC GUARD
|--------------------------------------------------------------------------
*/

function getMusicGuard(
  env
) {

  const id =
    env.MUSIC_GUARD.idFromName(
      "car-music-main"
    );


  return env.MUSIC_GUARD.get(
    id
  );

}

const PASSENGER_HTML = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Música del viaje</title>

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;

      display: flex;
      align-items: center;
      justify-content: center;

      padding: 24px;

      font-family:
        Inter,
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;

      background:
        radial-gradient(
          circle at top,
          #242424 0%,
          #121212 45%,
          #050505 100%
        );

      color: #fff;
    }

    .container {
      width: 100%;
      max-width: 460px;
    }

    .card {
      background: rgba(25,25,25,.96);

      border:
        1px solid rgba(255,255,255,.08);

      border-radius: 28px;

      padding: 32px 24px;

      box-shadow:
        0 30px 80px rgba(0,0,0,.45);
    }

    .icon {
      width: 66px;
      height: 66px;

      margin:
        0 auto 20px;

      display: flex;
      align-items: center;
      justify-content: center;

      border-radius: 50%;

      background: #1ed760;

      font-size: 32px;
    }

    h1 {
      margin: 0;

      text-align: center;

      font-size: 29px;
      line-height: 1.15;
    }

    .subtitle {
      margin:
        12px auto 26px;

      text-align: center;

      color: #b3b3b3;

      font-size: 15px;
      line-height: 1.5;
    }

    .availability {
      margin-bottom: 22px;

      padding: 13px 14px;

      border-radius: 14px;

      text-align: center;

      font-size: 14px;

      background: #222;

      color: #bbb;
    }

    .availability.on {
      background:
        rgba(30,215,96,.10);

      border:
        1px solid rgba(30,215,96,.28);

      color: #baf6ce;
    }

    .availability.off {
      background:
        rgba(255,107,107,.10);

      border:
        1px solid rgba(255,107,107,.25);

      color: #ffc2c2;
    }

    label {
      display: block;

      margin-bottom: 9px;

      font-size: 14px;
      font-weight: 600;

      color: #e8e8e8;
    }

    input {
      width: 100%;

      border:
        1px solid #4b4b4b;

      background: #242424;

      color: #fff;

      border-radius: 14px;

      padding: 17px 16px;

      font-size: 16px;

      outline: none;
    }

    input:focus {
      border-color: #1ed760;

      box-shadow:
        0 0 0 3px rgba(30,215,96,.15);
    }

    input:disabled {
      opacity: .5;
    }

    input::placeholder {
      color: #8d8d8d;
    }

    button {
      width: 100%;

      margin-top: 16px;

      border: 0;

      border-radius: 999px;

      padding: 17px;

      background: #1ed760;

      color: #000;

      font-size: 16px;
      font-weight: 800;

      cursor: pointer;
    }

    button:disabled {
      opacity: .5;

      cursor: not-allowed;
    }

    .status {
      display: none;

      margin-top: 22px;

      border-radius: 16px;

      padding: 16px;

      line-height: 1.4;
    }

    .status.loading {
      display: block;

      background: #252525;

      color: #d1d1d1;
    }

    .status.success {
      display: block;

      background:
        rgba(30,215,96,.12);

      border:
        1px solid rgba(30,215,96,.35);
    }

    .status.error {
      display: block;

      background:
        rgba(255,75,75,.12);

      border:
        1px solid rgba(255,75,75,.35);

      color: #ffb6b6;
    }

    .track {
      display: none;

      align-items: center;

      gap: 15px;

      margin-top: 20px;

      padding: 14px;

      background: #202020;

      border-radius: 18px;
    }

    .track.visible {
      display: flex;
    }

    .track img {
      width: 72px;
      height: 72px;

      border-radius: 10px;

      object-fit: cover;
    }

    .track-info {
      min-width: 0;

      overflow: hidden;
    }

    .track-name {
      font-weight: 800;

      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .artist {
      margin-top: 5px;

      color: #aaa;

      font-size: 14px;
    }

    .footer {
      margin-top: 24px;

      text-align: center;

      color: #707070;

      font-size: 12px;
    }

    .feedback-box {

        margin-top: 24px;

        padding: 20px;

        border-radius: 16px;

        background:
            #202020;

        border:
            1px solid #363636;

        text-align:
            center;

        }


        .feedback-title {

        font-size:
            17px;

        font-weight:
            700;

        margin-bottom:
            16px;

        color:
            #ffffff;

        }


        .feedback-actions {

        display:
            flex;

        gap:
            12px;

        }


        .feedback-button {

        flex:
            1;

        padding:
            14px;

        border:
            1px solid #444;

        border-radius:
            12px;

        background:
            #2a2a2a;

        color:
            white;

        font-size:
            16px;

        cursor:
            pointer;

        }


        .feedback-button:hover {

        background:
            #333;

        }


        .feedback-message {

        margin-top:
            12px;

        font-size:
            14px;

        color:
            #1ed760;

        }
  </style>
</head>

<body>

  <main class="container">

    <section class="card">

      <div class="icon">
        🎵
      </div>

      <h1>
        Elegí la música del viaje
      </h1>

      <p class="subtitle">
        Escribí una canción o artista y la reproducimos.
      </p>

      <div
        id="availability"
        class="availability"
      >
        Comprobando disponibilidad…
      </div>

      <form id="musicForm">

        <label for="query">
          ¿Qué querés escuchar?
        </label>

        <input
          id="query"
          type="text"
          maxlength="100"
          autocomplete="off"
          placeholder="Ej: Soda Stereo De Música Ligera"
          required
          disabled
        >

        <button
          id="submitButton"
          type="submit"
          disabled
        >
          ▶ Pedir canción
        </button>

      </form>

      <div
        id="status"
        class="status"
      ></div>

      <div
        id="feedbackBox"
        class="feedback-box"
        hidden
        >

        <div class="feedback-title">
            ¿Te gustó poder elegir la música del viaje?
        </div>

        <div class="feedback-actions">

            <button
            id="feedbackPositive"
            type="button"
            class="feedback-button"
            >
            👍 Sí
            </button>

            <button
            id="feedbackNegative"
            type="button"
            class="feedback-button"
            >
            👎 No
            </button>

        </div>

        <div
            id="feedbackMessage"
            class="feedback-message"
        ></div>

    </div>

      <div
        id="track"
        class="track"
      >

        <img
          id="cover"
          alt="Portada"
        >

        <div class="track-info">

          <div
            id="trackName"
            class="track-name"
          ></div>

          <div
            id="artist"
            class="artist"
          ></div>

        </div>

      </div>

      <div class="footer">
        🚗 Música durante tu viaje
      </div>

    </section>

  </main>


<script>

const feedbackBox =
  document.getElementById(
    "feedbackBox"
  );


const feedbackPositive =
  document.getElementById(
    "feedbackPositive"
  );


const feedbackNegative =
  document.getElementById(
    "feedbackNegative"
  );


const feedbackMessage =
  document.getElementById(
    "feedbackMessage"
  );

async function sendFeedback(
  vote
) {

  feedbackPositive.disabled =
    true;


  feedbackNegative.disabled =
    true;


  try {

    const clientId =
      getClientId();


    const response =
      await fetch(
        "/api/feedback",
        {

          method:
            "POST",

          headers: {

            "Content-Type":
              "application/json",

            "X-Client-Id":
              clientId

          },

          body:
            JSON.stringify(
              {
                vote
              }
            )

        }
      );


    const data =
      await response.json();


    if (
      !response.ok
    ) {

      throw new Error(
        data.error ||
        "No se pudo registrar tu opinión."
      );

    }


    feedbackMessage.textContent =
      "💚 ¡Gracias por tu opinión!";


    setTimeout(
      () => {

        feedbackBox.hidden =
          true;

      },
      2500
    );


  } catch (error) {

    feedbackMessage.textContent =
        error.message;


    feedbackPositive.disabled =
        false;


    feedbackNegative.disabled =
        false;

    }

}

feedbackPositive.addEventListener(
  "click",
  () =>
    sendFeedback(
      "positive"
    )
);


feedbackNegative.addEventListener(
  "click",
  () =>
    sendFeedback(
      "negative"
    )
);

const form =
  document.getElementById(
    "musicForm"
  );

const input =
  document.getElementById(
    "query"
  );

const button =
  document.getElementById(
    "submitButton"
  );

const statusBox =
  document.getElementById(
    "status"
  );

const availability =
  document.getElementById(
    "availability"
  );

const track =
  document.getElementById(
    "track"
  );

const cover =
  document.getElementById(
    "cover"
  );

const trackName =
  document.getElementById(
    "trackName"
  );

const artist =
  document.getElementById(
    "artist"
  );


let requestsEnabled =
  false;


function getClientId() {

  const key =
    "car_music_client_id";


  let value =
    localStorage.getItem(
      key
    );


  if (!value) {

    value =
      crypto.randomUUID
        ? crypto.randomUUID()
        : (
          "c_" +
          Date.now() +
          "_" +
          Math.random()
            .toString(36)
            .slice(2)
        );


    localStorage.setItem(
      key,
      value
    );
  }


  return value;
}


function setEnabled(
  enabled
) {

  requestsEnabled =
    enabled;


  input.disabled =
    !enabled;


  button.disabled =
    !enabled;


  availability.className =
    "availability " +
    (
      enabled
        ? "on"
        : "off"
    );


  availability.textContent =
    enabled
      ? "🟢 Pedidos de música habilitados"
      : "🔴 Los pedidos de música no están disponibles en este momento.";
}


async function refreshAvailability() {

  try {

    const response =
      await fetch(
        "/api/status",
        {
          cache:
            "no-store"
        }
      );


    const data =
      await response.json();


    setEnabled(
      Boolean(
        data.enabled
      )
    );

  } catch {

    setEnabled(
      false
    );


    availability.textContent =
      "No pudimos comprobar si los pedidos están habilitados.";

  }
}


form.addEventListener(
  "submit",
  async (event) => {

    event.preventDefault();

    feedbackBox.hidden =
    true;


    feedbackMessage.textContent =
    "";

    if (
      !requestsEnabled
    ) {

      return;
    }


    const query =
      input.value.trim();


    if (!query) {

      return;
    }


    button.disabled =
      true;


    input.disabled =
      true;


    button.textContent =
      "Buscando…";


    statusBox.className =
      "status loading";


    statusBox.textContent =
      "🔎 Buscando tu canción…";


    track.className =
      "track";


    try {

      const response =
        await fetch(
          "/api/request",
          {
            method:
              "POST",

            headers: {

              "Content-Type":
                "application/json",

              "X-Client-Id":
                getClientId()

            },

            body:
              JSON.stringify({
                query
              })
          }
        );


      const data =
        await response.json();


      if (!response.ok) {

        if (
          response.status === 403 &&
          data.code ===
            "REQUESTS_DISABLED"
        ) {

          setEnabled(
            false
          );

        }


        throw new Error(
          data.error ||
          "No se pudo reproducir la canción."
        );

      }


      statusBox.className =
        "status success";


      statusBox.textContent =
        "✅ ¡Tu canción ya está sonando!";


      trackName.textContent =
        data.track.name;


      artist.textContent =
        data.track.artist;


      if (
        data.track.image
      ) {

        cover.src =
          data.track.image;


        cover.style.display =
          "block";

      } else {

        cover.style.display =
          "none";

      }


      track.className =
        "track visible";


      input.value =
        "";

        /*
        |--------------------------------------------------------------------------
        | MOSTRAR ENCUESTA DE SATISFACCIÓN
        |--------------------------------------------------------------------------
        */

        setTimeout(
        () => {

            feedbackMessage.textContent =
            "";


            feedbackPositive.disabled =
            false;


            feedbackNegative.disabled =
            false;


            feedbackBox.hidden =
            false;

            feedbackBox.scrollIntoView({
            behavior: "smooth",
            block: "center"
            });

        },
        5000
        );


    } catch (error) {

      statusBox.className =
        "status error";


      statusBox.textContent =
        "❌ " +
        error.message;


    } finally {

      if (
        requestsEnabled
      ) {

        button.disabled =
          false;


        input.disabled =
          false;

      }


      button.textContent =
        "▶ Pedir canción";

    }

  }
);


refreshAvailability();


setInterval(
  refreshAvailability,
  15000
);

</script>

</body>

</html>`;


/*
|--------------------------------------------------------------------------
| PANEL ADMIN
|--------------------------------------------------------------------------
*/

const ADMIN_HTML = `<!doctype html>
<html lang="es">

<head>

  <meta charset="utf-8">

  <meta
    name="viewport"
    content="width=device-width,initial-scale=1"
  >

  <title>
    Panel conductor
  </title>

  <style>

    * {
      box-sizing:
        border-box;
    }

    body {

      margin: 0;

      min-height:
        100vh;

      display:
        flex;

      align-items:
        center;

      justify-content:
        center;

      padding:
        24px;

      font-family:
        Inter,
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;

      background:
        #0a0a0a;

      color:
        #fff;
    }

    .card {

      width:
        100%;

      max-width:
        440px;

      padding:
        30px 24px;

      background:
        #181818;

      border:
        1px solid #303030;

      border-radius:
        24px;

      box-shadow:
        0 30px 80px
        rgba(0,0,0,.45);
    }

    h1 {

      margin:
        0 0 8px;

      text-align:
        center;
    }

    .subtitle {

      margin:
        0 0 26px;

      color:
        #aaa;

      text-align:
        center;
    }

    label {

      display:
        block;

      margin-bottom:
        8px;

      font-weight:
        600;
    }

    input {

      width:
        100%;

      padding:
        15px 16px;

      border-radius:
        12px;

      border:
        1px solid #494949;

      background:
        #252525;

      color:
        #fff;

      font-size:
        16px;

      outline:
        none;
    }

    input:focus {

      border-color:
        #1ed760;
    }

    button {

      width:
        100%;

      padding:
        15px;

      margin-top:
        14px;

      border:
        0;

      border-radius:
        999px;

      font-weight:
        800;

      font-size:
        15px;

      cursor:
        pointer;
    }

    .primary {

      background:
        #1ed760;

      color:
        #000;
    }

    .danger {

      background:
        #ff5757;

      color:
        #fff;
    }

    .logout {

      background:
        #303030;

      color:
        #fff;
    }

    button:disabled {

      opacity:
        .55;

      cursor:
        wait;
    }

    .message {

      display:
        none;

      padding:
        13px;

      margin-top:
        16px;

      border-radius:
        12px;

      font-size:
        14px;
    }

    .message.show {

      display:
        block;
    }

    .message.error {

      background:
        rgba(255,75,75,.12);

      color:
        #ffc3c3;
    }

    .message.ok {

      background:
        rgba(30,215,96,.12);

      color:
        #bff5d0;
    }

    #panel {

      display:
        none;
    }

    .state {

      margin:
        24px 0;

      padding:
        22px;

      border-radius:
        18px;

      text-align:
        center;

      background:
        #222;
    }

    .state-title {

      font-size:
        28px;

      font-weight:
        900;
    }

    .state-detail {

      margin-top:
        9px;

      color:
        #aaa;

      line-height:
        1.45;
    }

    .hint {

      margin-top:
        20px;

      color:
        #777;

      font-size:
        12px;

      text-align:
        center;
    }

    .feedback-stats {

        margin:
            22px 0;

        padding:
            20px;

        border-radius:
            18px;

        background:
            #222;

        border:
            1px solid #333;

        }


        .feedback-stats-title {

        margin-bottom:
            18px;

        text-align:
            center;

        font-size:
            18px;

        font-weight:
            800;

        }


        .feedback-numbers {

        display:
            grid;

        grid-template-columns:
            1fr 1fr;

        gap:
            12px;

        }


        .feedback-stat {

        padding:
            14px;

        border-radius:
            14px;

        background:
            #2b2b2b;

        text-align:
            center;

        }


        .feedback-stat-number {

        font-size:
            28px;

        font-weight:
            900;

        }


        .feedback-stat-label {

        margin-top:
            5px;

        color:
            #aaa;

        font-size:
            14px;

        }


        .feedback-satisfaction {

        margin-top:
            16px;

        padding:
            15px;

        border-radius:
            14px;

        background:
            rgba(30,215,96,.10);

        text-align:
            center;

        }


        .feedback-satisfaction-label {

        color:
            #aaa;

        font-size:
            13px;

        }


        .feedback-satisfaction-value {

        margin-top:
            4px;

        color:
            #1ed760;

        font-size:
            32px;

        font-weight:
            900;

        }


        .feedback-total {

        margin-top:
            12px;

        text-align:
            center;

        color:
            #888;

        font-size:
            13px;

        }

  </style>

</head>


<body>

<section class="card">

  <h1>
    🚗 Panel conductor
  </h1>

  <p class="subtitle">
    Car Music Request
  </p>


  <div id="login">

    <form id="loginForm">

      <label for="password">
        Contraseña
      </label>

      <input
        id="password"
        type="password"
        autocomplete="current-password"
        required
      >

      <button
        id="loginButton"
        class="primary"
        type="submit"
      >
        Ingresar
      </button>

    </form>

  </div>


  <div id="panel">

    <div class="state">

      <div
        id="stateTitle"
        class="state-title"
      >
        Consultando…
      </div>

      <div
        id="stateDetail"
        class="state-detail"
      ></div>

    </div>

    <div
        id="feedbackStats"
        class="feedback-stats"
    >

    <div class="feedback-stats-title">
        📊 Opinión de pasajeros
    </div>

    <div class="feedback-numbers">

        <div class="feedback-stat">
        <div
            id="feedbackPositiveCount"
            class="feedback-stat-number"
        >
            0
        </div>

        <div class="feedback-stat-label">
            👍 Sí
        </div>
        </div>


        <div class="feedback-stat">
        <div
            id="feedbackNegativeCount"
            class="feedback-stat-number"
        >
            0
        </div>

        <div class="feedback-stat-label">
            👎 No
        </div>
        </div>

    </div>


    <div class="feedback-satisfaction">

        <div class="feedback-satisfaction-label">
        Satisfacción
        </div>

        <div
        id="feedbackSatisfaction"
        class="feedback-satisfaction-value"
        >
        0%
        </div>

    </div>


    <div
        id="feedbackTotal"
        class="feedback-total"
    >
        Votos totales: 0
    </div>

    </div>

    <button
      id="toggleButton"
      class="primary"
      type="button"
    >
      Cambiar estado
    </button>


    <button
      id="logoutButton"
      class="logout"
      type="button"
    >
      Cerrar sesión y apagar
    </button>

  </div>


  <div
    id="message"
    class="message"
  ></div>


  <div class="hint">

    Cuando activás los pedidos,
    se apagan automáticamente
    después de 12 horas.

  </div>

</section>


<script>

const TOKEN_KEY =
  "car_music_admin_token";


const login =
  document.getElementById(
    "login"
  );


const panel =
  document.getElementById(
    "panel"
  );


const loginForm =
  document.getElementById(
    "loginForm"
  );


const password =
  document.getElementById(
    "password"
  );


const loginButton =
  document.getElementById(
    "loginButton"
  );


const stateTitle =
  document.getElementById(
    "stateTitle"
  );


const stateDetail =
  document.getElementById(
    "stateDetail"
  );


const toggleButton =
  document.getElementById(
    "toggleButton"
  );


const logoutButton =
  document.getElementById(
    "logoutButton"
  );


const message =
  document.getElementById(
    "message"
  );

const feedbackPositiveCount =
  document.getElementById(
    "feedbackPositiveCount"
  );


const feedbackNegativeCount =
  document.getElementById(
    "feedbackNegativeCount"
  );


const feedbackSatisfaction =
  document.getElementById(
    "feedbackSatisfaction"
  );


const feedbackTotal =
  document.getElementById(
    "feedbackTotal"
  );

async function loadFeedbackStats() {

  if (
    !token()
  ) {

    return;
  }


  try {

    const response =
      await fetch(
        "/api/admin/feedback",
        {

          headers:
            authHeaders(),

          cache:
            "no-store"

        }
      );


    if (
      response.status === 401
    ) {

      return;
    }


    const data =
      await response.json();


    if (
      !response.ok
    ) {

      console.error(
        "Feedback stats error:",
        data
      );

      return;
    }


    feedbackPositiveCount.textContent =
      data.positive || 0;


    feedbackNegativeCount.textContent =
      data.negative || 0;


    feedbackSatisfaction.textContent =
      (data.satisfaction || 0) +
      "%";


    feedbackTotal.textContent =
      "Votos totales: " +
      (data.total || 0);


  } catch (error) {

    console.error(
      "No se pudieron cargar estadísticas:",
      error
    );

  }

}

let currentEnabled =
  false;


const token =
  () =>
    sessionStorage.getItem(
      TOKEN_KEY
    );


function showMessage(
  text,
  type = "ok"
) {

  message.className =
    "message show " +
    type;


  message.textContent =
    text;
}


function clearMessage() {

  message.className =
    "message";


  message.textContent =
    "";
}


function showLogin() {

  login.style.display =
    "block";


  panel.style.display =
    "none";
}


function showPanel() {

  login.style.display =
    "none";


  panel.style.display =
    "block";
}


const authHeaders =
  () => ({

    Authorization:
      "Bearer " +
      token()

  });


function formatRemaining(
  until
) {

  if (!until) {

    return "";

  }


  const ms =
    Math.max(
      0,
      until -
      Date.now()
    );


  const hours =
    Math.floor(
      ms /
      3600000
    );


  const minutes =
    Math.floor(
      (
        ms %
        3600000
      ) /
      60000
    );


  return (
    hours +
    " h " +
    minutes +
    " min"
  );
}


function renderState(
  data
) {

  currentEnabled =
    Boolean(
      data.enabled
    );


  if (
    currentEnabled
  ) {

    stateTitle.textContent =
      "🟢 ACTIVO";


    stateDetail.textContent =
      "Los pasajeros pueden pedir música. Autoapagado en " +
      formatRemaining(
        data.enabledUntil
      ) +
      ".";


    toggleButton.textContent =
      "🔴 Desactivar pedidos";


    toggleButton.className =
      "danger";


  } else {


    stateTitle.textContent =
      "🔴 DESACTIVADO";


    stateDetail.textContent =
      "Los pasajeros no pueden cambiar la música.";


    toggleButton.textContent =
      "🟢 Activar pedidos";


    toggleButton.className =
      "primary";

  }
}


async function loadStatus() {

  if (
    !token()
  ) {

    showLogin();

    return;
  }


  const response =
    await fetch(
      "/api/admin/status",
      {

        headers:
          authHeaders(),

        cache:
          "no-store"

      }
    );


  if (
    response.status === 401
  ) {

    sessionStorage.removeItem(
      TOKEN_KEY
    );


    showLogin();


    showMessage(
      "Tu sesión venció. Ingresá nuevamente.",
      "error"
    );


    return;
  }


  const data =
    await response.json();


  if (
    !response.ok
  ) {

    showMessage(
      data.error ||
      "No se pudo obtener el estado.",
      "error"
    );


    return;
  }


  showPanel();


  renderState(
    data
  );

  await loadFeedbackStats();
}


loginForm.addEventListener(
  "submit",
  async (event) => {

    event.preventDefault();


    clearMessage();


    loginButton.disabled =
      true;


    loginButton.textContent =
      "Ingresando…";


    try {

      const response =
        await fetch(
          "/api/admin/login",
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify({

                password:
                  password.value

              })
          }
        );


      const data =
        await response.json();


      if (
        !response.ok
      ) {

        throw new Error(
          data.error ||
          "No se pudo iniciar sesión."
        );

      }


      sessionStorage.setItem(
        TOKEN_KEY,
        data.token
      );


      password.value =
        "";


      showMessage(
        "Sesión iniciada."
      );


      await loadStatus();


    } catch (error) {

      showMessage(
        error.message,
        "error"
      );


    } finally {

      loginButton.disabled =
        false;


      loginButton.textContent =
        "Ingresar";

    }

  }
);


toggleButton.addEventListener(
  "click",
  async () => {

    clearMessage();


    toggleButton.disabled =
      true;


    try {

      const response =
        await fetch(
          "/api/admin/toggle",
          {
            method:
              "POST",

            headers: {

              ...authHeaders(),

              "Content-Type":
                "application/json"

            },

            body:
              JSON.stringify({

                enabled:
                  !currentEnabled

              })
          }
        );


      const data =
        await response.json();


      if (
        response.status === 401
      ) {

        sessionStorage.removeItem(
          TOKEN_KEY
        );


        showLogin();


        throw new Error(
          "Tu sesión venció."
        );

      }


      if (
        !response.ok
      ) {

        throw new Error(
          data.error ||
          "No se pudo cambiar el estado."
        );

      }


      renderState(
        data
      );


      showMessage(
        data.enabled
          ? "Pedidos habilitados."
          : "Pedidos deshabilitados."
      );


    } catch (error) {

      showMessage(
        error.message,
        "error"
      );


    } finally {

      toggleButton.disabled =
        false;

    }

  }
);

logoutButton.addEventListener(
  "click",
  async () => {

    clearMessage();


    logoutButton.disabled =
      true;


    logoutButton.textContent =
      "Apagando…";


    try {

      const currentToken =
        token();


      if (!currentToken) {

        throw new Error(
          "No hay una sesión activa."
        );

      }


      const response =
        await fetch(
          "/api/admin/logout",
          {

            method:
              "POST",

            headers: {

              Authorization:
                "Bearer " +
                currentToken

            }

          }
        );


      const data =
        await response.json();


      console.log(
        "Logout response:",
        response.status,
        data
      );


      if (!response.ok) {

        throw new Error(
          data.error ||
          "No se pudo apagar el sistema."
        );

      }


      /*
      |--------------------------------------------------------------------------
      | IMPORTANTE:
      |
      | Sólo borramos la sesión DESPUÉS
      | de confirmar que el backend quedó apagado.
      |--------------------------------------------------------------------------
      */

      sessionStorage.removeItem(
        TOKEN_KEY
      );


      currentEnabled =
        false;


      showLogin();


      showMessage(
        "Pedidos desactivados y sesión cerrada.",
        "ok"
      );


    } catch (error) {

      console.error(
        "Logout error:",
        error
      );


      showMessage(
        error.message,
        "error"
      );


    } finally {

      logoutButton.disabled =
        false;


      logoutButton.textContent =
        "Cerrar sesión y apagar";

    }

  }
);


loadStatus();

setInterval(
  () => {

    if (
      token()
    ) {

      loadFeedbackStats();

    }

  },
  15000
);

</script>

</body>

</html>`;


/*
|--------------------------------------------------------------------------
| WORKER
|--------------------------------------------------------------------------
*/

export default {

  async fetch(
    request,
    env
  ) {

    const url =
      new URL(
        request.url
      );


    try {

      /*
      |--------------------------------------------------------------------------
      | FRONTEND PASAJERO
      |--------------------------------------------------------------------------
      */

      if (
        request.method === "GET" &&
        url.pathname === "/"
      ) {

        return html(
          PASSENGER_HTML
        );
      }


      /*
      |--------------------------------------------------------------------------
      | PANEL ADMIN
      |--------------------------------------------------------------------------
      */

      if (
        request.method === "GET" &&
        url.pathname === "/admin"
      ) {

        return html(
          ADMIN_HTML
        );
      }


      /*
      |--------------------------------------------------------------------------
      | FAVICON
      |--------------------------------------------------------------------------
      */

      if (
        request.method === "GET" &&
        url.pathname === "/favicon.ico"
      ) {

        return new Response(
          null,
          {
            status:
              204
          }
        );
      }


      /*
      |--------------------------------------------------------------------------
      | ESTADO PÚBLICO
      |--------------------------------------------------------------------------
      */

      if (
        request.method === "GET" &&
        url.pathname === "/api/status"
      ) {

        const state =
          await getMusicState(
            env
          );


        return json(
          state
        );
      }


      /*
      |--------------------------------------------------------------------------
      | ADMIN LOGIN
      |--------------------------------------------------------------------------
      */

      if (
        request.method === "POST" &&
        url.pathname ===
          "/api/admin/login"
      ) {

        return await handleAdminLogin(
          request,
          env,
          url
        );
      }


      /*
      |--------------------------------------------------------------------------
      | ADMIN STATUS
      |--------------------------------------------------------------------------
      */

      if (
        request.method === "GET" &&
        url.pathname ===
          "/api/admin/status"
      ) {

        return await handleAdminStatus(
          request,
          env,
          url
        );
      }


      /*
      |--------------------------------------------------------------------------
      | ADMIN ON/OFF
      |--------------------------------------------------------------------------
      */

      if (
        request.method === "POST" &&
        url.pathname ===
          "/api/admin/toggle"
      ) {

        return await handleAdminToggle(
          request,
          env,
          url
        );
      }

        /*
      |--------------------------------------------------------------------------
      | CERRAR SESION ADMIN
      |--------------------------------------------------------------------------
      */

      if (
        request.method === "POST" &&
        url.pathname ===
            "/api/admin/logout"
        ) {

        return await handleAdminLogout(
            request,
            env,
            url
        );

        }


      /*
      |--------------------------------------------------------------------------
      | PEDIR CANCIÓN
      |--------------------------------------------------------------------------
      */

      if (
        request.method === "POST" &&
        url.pathname ===
          "/api/request"
      ) {

        return await handleMusicRequest(
          request,
          env,
          url
        );
      }

      /*
      |--------------------------------------------------------------------------
      | DAR FEEDBACK
      |--------------------------------------------------------------------------
      */

      if (
        request.method === "POST" &&
        url.pathname === "/api/feedback"
        ) {

        return await handleFeedback(
            request,
            env,
            url
        );

        }

        /*
      |--------------------------------------------------------------------------
      | ADMIN FEEDBACK
      |--------------------------------------------------------------------------
      */

        if (
            request.method === "GET" &&
            url.pathname ===
                "/api/admin/feedback"
        ) {

        return await handleAdminFeedback(
            request,
            env
        );

        }


      return secureResponse(
        "Not Found",
        {
          status:
            404
        }
      );


    } catch (error) {


      if (
        error instanceof
        HttpError
      ) {

        return json(
          {
            error:
              error.message
          },
          error.status
        );

      }


      console.error(
        "Unhandled Worker Error:",
        error
      );


      if (
        error?.message ===
        "NO_DEVICE"
      ) {

        return json(
          {
            error:
              "Spotify no encuentra tu teléfono. Abrí Spotify, reproducí cualquier canción unos segundos y volvé a intentar."
          },
          409
        );

      }


      if (
        error?.message ===
        "PLAYBACK_ERROR"
      ) {

        return json(
          {
            error:
              "Spotify encontró el teléfono pero no pudo confirmar la reproducción. Intentá nuevamente."
          },
          409
        );

      }


      if (
        error?.message ===
        "TOKEN_ERROR"
      ) {

        return json(
          {
            error:
              "No pudimos autenticarnos con Spotify."
          },
          500
        );

      }

      if (
        error?.message ===
        "SPOTIFY_SEARCH_TEMPORARY"
        ) {

        return json(
            {
            error:
                "Spotify tuvo un problema temporal buscando la canción. Intentá nuevamente en unos segundos."
            },
            503
        );

        }


        if (
        error?.message ===
        "SPOTIFY_RATE_LIMIT"
        ) {

        return json(
            {
            error:
                "Spotify está recibiendo demasiadas solicitudes. Esperá unos segundos y volvé a intentar."
            },
            429
        );

        }


        if (
        error?.message ===
        "SEARCH_ERROR"
        ) {

        return json(
            {
            error:
                "Spotify no pudo realizar la búsqueda en este momento."
            },
            502
        );

        }

      return json(
        {
          error:
            "Ocurrió un error interno."
        },
        500
      );

    }

  }

};

async function handleFeedback(
  request,
  env,
  url
) {

  assertSameOrigin(
    request,
    url
  );


  const clientId =
    request.headers.get(
      "X-Client-Id"
    );


  if (
    !clientId ||
    !/^[A-Za-z0-9_-]{16,100}$/.test(
      clientId
    )
  ) {

    return json(
      {
        error:
          "Identificador inválido."
      },
      400
    );

  }


  const body =
    await readJsonBody(
      request
    );


  const vote =
    body?.vote;


  if (
    vote !== "positive" &&
    vote !== "negative"
  ) {

    return json(
      {
        error:
          "Voto inválido."
      },
      400
    );

  }


  const guard =
    getMusicGuard(
      env
    );


  const result =
    await guard.submitFeedback(
      clientId,
      vote
    );


  if (
    !result.accepted &&
    result.reason ===
      "ALREADY_VOTED"
  ) {

    return json(
      {
        code:
          "ALREADY_VOTED",

        error:
          "Ya registramos tu opinión. ¡Gracias!"
      },
      409
    );

  }


  if (
    !result.accepted &&
    result.reason ===
      "DISABLED"
  ) {

    return json(
      {
        code:
          "REQUESTS_DISABLED",

        error:
          "La sesión ya finalizó."
      },
      403
    );

  }


  return json(
    {
      ok:
        true,

      message:
        "¡Gracias por tu opinión!"
    }
  );

}

async function handleAdminFeedback(
  request,
  env
) {

  if (
    !await isAuthorizedAdmin(
      request,
      env
    )
  ) {

    return json(
      {
        error:
          "Sesión no válida."
      },
      401
    );

  }


  const guard =
    getMusicGuard(
      env
    );


  const stats =
    await guard.getFeedbackStats();


  return json(
    stats
  );

}


/*
|--------------------------------------------------------------------------
| PEDIDO DE MÚSICA
|--------------------------------------------------------------------------
*/

async function handleMusicRequest(
  request,
  env,
  url
) {

  assertSameOrigin(
    request,
    url
  );

  /*
  |--------------------------------------------------------------------------
  | IDENTIFICADOR DEL PASAJERO
  |--------------------------------------------------------------------------
  */

  const clientId =
    request.headers.get(
      "X-Client-Id"
    ) || "";


  if (
    !/^[A-Za-z0-9_-]{16,100}$/
      .test(
        clientId
      )
  ) {

    return json(
      {
        error:
          "Identificador de pasajero inválido."
      },
      400
    );

  }

  /*
  |--------------------------------------------------------------------------
  | BODY
  |--------------------------------------------------------------------------
  */

  const body =
    await readJsonBody(
      request
    );


  const query =
    typeof body?.query ===
      "string"
        ? body.query.trim()
        : "";


  if (
    query.length < 2 ||
    query.length >
      MAX_QUERY_LENGTH
  ) {

    return json(
      {
        error:
          "La búsqueda debe tener entre 2 y " +
          MAX_QUERY_LENGTH +
          " caracteres."
      },
      400
    );

  }


  console.log(
    "\n--------------------------------"
  );


  console.log(
    "Nueva petición:",
    query
  );

  /*
|--------------------------------------------------------------------------
| GUARD ESTRICTO
|--------------------------------------------------------------------------
*/

const guard =
  getMusicGuard(
    env
  );


const guardResult =
  await guard.checkMusicRequest(
    clientId
  );


/*
|--------------------------------------------------------------------------
| SISTEMA OFF
|--------------------------------------------------------------------------
*/

if (
  !guardResult.allowed &&
  guardResult.reason ===
    "DISABLED"
) {

  return json(
    {

      code:
        "REQUESTS_DISABLED",

      error:
        "Los pedidos de música no están habilitados en este momento."

    },
    403
  );

}


/*
|--------------------------------------------------------------------------
| COOLDOWN GLOBAL
|--------------------------------------------------------------------------
*/

if (
  !guardResult.allowed &&
  guardResult.reason ===
    "GLOBAL_COOLDOWN"
) {

  const seconds =
    Math.ceil(
      guardResult.retryAfterMs /
      1000
    );


  return json(
    {

      code:
        "GLOBAL_COOLDOWN",

      error:
        "Esperá " +
        seconds +
        " segundos antes de pedir otra canción.",

      retryAfter:
        seconds

    },
    429
  );

}


/*
|--------------------------------------------------------------------------
| 3 PEDIDOS / MINUTO
|--------------------------------------------------------------------------
*/

if (
  !guardResult.allowed &&
  guardResult.reason ===
    "PASSENGER_LIMIT"
) {

  const seconds =
    Math.ceil(
      guardResult.retryAfterMs /
      1000
    );


  return json(
    {

      code:
        "PASSENGER_LIMIT",

      error:
        "Ya pediste 3 canciones durante el último minuto. Esperá " +
        seconds +
        " segundos.",

      retryAfter:
        seconds

    },
    429
  );

}


  /*
  |--------------------------------------------------------------------------
  | SPOTIFY TOKEN
  |--------------------------------------------------------------------------
  */

  const accessToken =
    await getAccessToken(
      env
    );


  console.log(
    "✅ Access Token obtenido."
  );


  /*
  |--------------------------------------------------------------------------
  | BUSCAR CANCIÓN
  |--------------------------------------------------------------------------
  */

  const spotifyTrack =
    await searchTrack(
      accessToken,
      query
    );


  if (
    !spotifyTrack
  ) {

    return json(
      {
        error:
          "No encontramos esa canción."
      },
      404
    );

  }

  /*
  |--------------------------------------------------------------------------
  | ARTISTAS
  |--------------------------------------------------------------------------
  */

  const artists =
    spotifyTrack.artists
      .map(
        artist =>
          artist.name
      )
      .join(", ");


  console.log(
    "🎵 Canción seleccionada:",
    spotifyTrack.name,
    "-",
    artists
  );


  /*
  |--------------------------------------------------------------------------
  | REPRODUCCIÓN
  |--------------------------------------------------------------------------
  */

  const playbackResult =
    await playTrackResilient(
      accessToken,
      spotifyTrack.uri
    );


  console.log(
    "✅ Playback confirmado."
  );


  return json(
    {

      ok:
        true,

      device:
        playbackResult.deviceName ||
        "Spotify",

      track: {

        name:
          spotifyTrack.name,

        artist:
          artists,

        image:
          spotifyTrack.album
            ?.images?.[0]
            ?.url ||
          null,

        uri:
          spotifyTrack.uri

      }

    }
  );

}


/*
|--------------------------------------------------------------------------
| ADMIN LOGIN
|--------------------------------------------------------------------------
*/

async function handleAdminLogin(
  request,
  env,
  url
) {

  assertSameOrigin(
    request,
    url
  );


  /*
  |--------------------------------------------------------------------------
  | RATE LIMIT LOGIN
  |--------------------------------------------------------------------------
  */

  const guard =
    getMusicGuard(
        env
    );


    const loginGuard =
    await guard.checkAdminLogin();


    if (
    !loginGuard.allowed
    ) {

        return json(
            {
            error:
                "Demasiados intentos de acceso. Esperá un minuto."
            },
            429
        );

    }


  const body =
    await readJsonBody(
      request
    );


  const supplied =
    typeof body?.password ===
      "string"
        ? body.password
        : "";


  const valid =
    await safeStringEqual(
      supplied,
      env.ADMIN_PASSWORD ||
      ""
    );


  if (
    !valid
  ) {

    await sleep(
      250
    );


    return json(
      {
        error:
          "Contraseña incorrecta."
      },
      401
    );

  }

  await guard.clearAdminAttempts();

  const token =
    await createAdminToken(
      env.ADMIN_PASSWORD
    );


  return json(
    {

      ok:
        true,

      token,

      expiresInSeconds:
        ADMIN_SESSION_HOURS *
        60 *
        60

    }
  );

}


/*
|--------------------------------------------------------------------------
| ADMIN STATUS
|--------------------------------------------------------------------------
*/

async function handleAdminStatus(
  request,
  env
) {

  if (
    !await isAuthorizedAdmin(
      request,
      env
    )
  ) {

    return json(
      {
        error:
          "Sesión no válida."
      },
      401
    );

  }


  return json(
    await getMusicState(
      env
    )
  );

}


/*
|--------------------------------------------------------------------------
| ADMIN TOGGLE
|--------------------------------------------------------------------------
*/

async function handleAdminToggle(
  request,
  env,
  url
) {

  assertSameOrigin(
    request,
    url
  );


  if (
    !await isAuthorizedAdmin(
      request,
      env
    )
  ) {

    return json(
      {
        error:
          "Sesión no válida."
      },
      401
    );

  }


  const body =
    await readJsonBody(
      request
    );


  if (
    typeof body?.enabled !==
    "boolean"
  ) {

    return json(
      {
        error:
          "Estado inválido."
      },
      400
    );

  }


  const guard =
    getMusicGuard(
      env
    );


  const result =
    await guard.setEnabled(
      body.enabled
    );


  return json(
    result
  );

}


/*
|--------------------------------------------------------------------------
| ADMIN LOGOUT
|--------------------------------------------------------------------------
*/

async function handleAdminLogout(
  request,
  env,
  url
) {

  assertSameOrigin(
    request,
    url
  );


  if (
    !await isAuthorizedAdmin(
      request,
      env
    )
  ) {

    return json(
      {
        error:
          "Sesión no válida."
      },
      401
    );
  }


  const guard =
    getMusicGuard(
      env
    );


  console.log(
    "🔴 APAGANDO MUSIC GUARD..."
  );


  const result =
    await guard.setEnabled(
      false
    );


  console.log(
    "Resultado setEnabled(false):",
    result
  );


  const state =
    await guard.getStatus();


  console.log(
    "Estado real después del logout:",
    state
  );


  return json(
    {
      ok: true,

      enabled:
        state.enabled,

      enabledUntil:
        state.enabledUntil
    }
  );
}

/*
|--------------------------------------------------------------------------
| ESTADO KV
|--------------------------------------------------------------------------
*/

async function getMusicState(
  env
) {

  const guard =
    getMusicGuard(
      env
    );


  return await guard.getStatus();

}

/*
|--------------------------------------------------------------------------
| TOKEN ADMIN
|--------------------------------------------------------------------------
*/

async function createAdminToken(
  secret
) {

  const payload =
    {

      v:
        1,

      exp:
        Date.now() +
        ADMIN_SESSION_HOURS *
        60 *
        60 *
        1000

    };


  const payloadText =
    JSON.stringify(
      payload
    );


  const payloadPart =
    base64UrlEncode(
      new TextEncoder()
        .encode(
          payloadText
        )
    );


  const signature =
    await hmacSign(
      secret,
      payloadPart
    );


  return (
    payloadPart +
    "." +
    base64UrlEncode(
      signature
    )
  );

}


async function isAuthorizedAdmin(
  request,
  env
) {

  const authorization =
    request.headers.get(
      "Authorization"
    ) || "";


  if (
    !authorization.startsWith(
      "Bearer "
    )
  ) {

    return false;

  }


  const token =
    authorization
      .slice(7)
      .trim();


  return verifyAdminToken(
    token,
    env.ADMIN_PASSWORD ||
    ""
  );

}


async function verifyAdminToken(
  token,
  secret
) {

  try {

    const parts =
      token.split(".");


    if (
      parts.length !==
      2
    ) {

      return false;

    }


    const [
      payloadPart,
      signaturePart
    ] =
      parts;


    const receivedSignature =
      base64UrlDecode(
        signaturePart
      );


    const expectedSignature =
      await hmacSign(
        secret,
        payloadPart
      );


    if (
      !equalBytes(
        receivedSignature,
        expectedSignature
      )
    ) {

      return false;

    }


    const payload =
      JSON.parse(

        new TextDecoder()
          .decode(

            base64UrlDecode(
              payloadPart
            )

          )

      );


    return (
      payload?.v === 1
      &&
      Number.isFinite(
        payload?.exp
      )
      &&
      payload.exp >
        Date.now()
    );


  } catch {

    return false;

  }

}


/*
|--------------------------------------------------------------------------
| HMAC
|--------------------------------------------------------------------------
*/

async function hmacSign(
  secret,
  value
) {

  const key =
    await crypto.subtle.importKey(
      "raw",

      new TextEncoder()
        .encode(
          secret
        ),

      {

        name:
          "HMAC",

        hash:
          "SHA-256"

      },

      false,

      [
        "sign"
      ]
    );


  const signature =
    await crypto.subtle.sign(
      "HMAC",
      key,

      new TextEncoder()
        .encode(
          value
        )
    );


  return new Uint8Array(
    signature
  );

}


/*
|--------------------------------------------------------------------------
| BASE64 URL
|--------------------------------------------------------------------------
*/

function base64UrlEncode(
  bytes
) {

  let binary =
    "";


  for (
    const byte
    of bytes
  ) {

    binary +=
      String.fromCharCode(
        byte
      );

  }


  return btoa(
    binary
  )
    .replace(
      /\+/g,
      "-"
    )
    .replace(
      /\//g,
      "_"
    )
    .replace(
      /=+$/g,
      ""
    );

}


function base64UrlDecode(
  value
) {

  const padded =
    value
      .replace(
        /-/g,
        "+"
      )
      .replace(
        /_/g,
        "/"
      )
      .padEnd(
        Math.ceil(
          value.length /
          4
        ) *
        4,
        "="
      );


  const binary =
    atob(
      padded
    );


  const bytes =
    new Uint8Array(
      binary.length
    );


  for (
    let i = 0;
    i < binary.length;
    i++
  ) {

    bytes[i] =
      binary.charCodeAt(
        i
      );

  }


  return bytes;

}


/*
|--------------------------------------------------------------------------
| COMPARACIÓN SEGURA
|--------------------------------------------------------------------------
*/

function equalBytes(
  a,
  b
) {

  if (
    a.length !==
    b.length
  ) {

    return false;

  }


  let difference =
    0;


  for (
    let i = 0;
    i < a.length;
    i++
  ) {

    difference |=
      a[i] ^
      b[i];

  }


  return (
    difference ===
    0
  );

}


async function safeStringEqual(
  a,
  b
) {

  const encoder =
    new TextEncoder();


  const [
    aHash,
    bHash
  ] =
    await Promise.all(
      [

        crypto.subtle.digest(
          "SHA-256",
          encoder.encode(a)
        ),

        crypto.subtle.digest(
          "SHA-256",
          encoder.encode(b)
        )

      ]
    );


  return equalBytes(

    new Uint8Array(
      aHash
    ),

    new Uint8Array(
      bHash
    )

  );

}


/*
|--------------------------------------------------------------------------
| SPOTIFY - ACCESS TOKEN
|--------------------------------------------------------------------------
*/

async function getAccessToken(
  env
) {

  if (
    !env.SPOTIFY_CLIENT_ID
    ||
    !env.SPOTIFY_CLIENT_SECRET
    ||
    !env.SPOTIFY_REFRESH_TOKEN
  ) {

    throw new Error(
      "TOKEN_ERROR"
    );

  }


  const credentials =
    btoa(
      env.SPOTIFY_CLIENT_ID +
      ":" +
      env.SPOTIFY_CLIENT_SECRET
    );


  const response =
    await fetch(
      "https://accounts.spotify.com/api/token",
      {

        method:
          "POST",

        headers: {

          Authorization:
            "Basic " +
            credentials,

          "Content-Type":
            "application/x-www-form-urlencoded"

        },

        body:
          new URLSearchParams(
            {

              grant_type:
                "refresh_token",

              refresh_token:
                env.SPOTIFY_REFRESH_TOKEN

            }
          )

      }
    );


  if (
    !response.ok
  ) {

    const error =
      await response.text();


    console.error(
      "Token Error:",
      response.status,
      error
    );


    throw new Error(
      "TOKEN_ERROR"
    );

  }


  const data =
    await response.json();


  return data.access_token;

}


/*
|--------------------------------------------------------------------------
| SPOTIFY - BUSCAR CANCIÓN
|--------------------------------------------------------------------------
*/

async function searchTrack(
  accessToken,
  query
) {

  const params =
    new URLSearchParams(
      {

        q:
          query,

        type:
          "track",

        limit:
          "10"

      }
    );


  const url =
    "https://api.spotify.com/v1/search?" +
    params.toString();


  let data =
    null;


  /*
  |--------------------------------------------------------------------------
  | SEARCH CON RETRY
  |--------------------------------------------------------------------------
  */

  for (
    let attempt = 1;
    attempt <= 3;
    attempt++
  ) {

    console.log(
      `🔎 Spotify Search intento ${attempt}`
    );


    const response =
      await fetch(
        url,
        {

          headers: {

            Authorization:
              "Bearer " +
              accessToken

          }

        }
      );


    /*
    |--------------------------------------------------------------------------
    | OK
    |--------------------------------------------------------------------------
    */

    if (
      response.ok
    ) {

      data =
        await response.json();


      break;

    }


    /*
    |--------------------------------------------------------------------------
    | ERROR
    |--------------------------------------------------------------------------
    */

    const errorBody =
      await response.text();


    console.log(
      "⚠️ Spotify Search respondió:",
      response.status,
      errorBody
    );


    /*
    |--------------------------------------------------------------------------
    | RATE LIMIT
    |--------------------------------------------------------------------------
    */

    if (
      response.status === 429
    ) {

      const retryAfter =
        Number(
          response.headers.get(
            "Retry-After"
          ) || 1
        );


      console.log(
        `⏳ Spotify pidió esperar ${retryAfter}s`
      );


      /*
      | No queremos dejar al pasajero
      | esperando demasiado.
      */

      if (
        retryAfter > 5
      ) {

        throw new Error(
          "SPOTIFY_RATE_LIMIT"
        );

      }


      if (
        attempt < 3
      ) {

        await sleep(
          retryAfter *
          1000
        );


        continue;

      }


      throw new Error(
        "SPOTIFY_RATE_LIMIT"
      );

    }


    /*
    |--------------------------------------------------------------------------
    | ERRORES TEMPORALES DE SPOTIFY
    |--------------------------------------------------------------------------
    */

    if (
      [
        500,
        502,
        503,
        504
      ].includes(
        response.status
      )
    ) {

      if (
        attempt <
        3
      ) {

        const waitMs =
          attempt *
          700;


        console.log(
          `🔁 Error temporal. Reintentando en ${waitMs} ms...`
        );


        await sleep(
          waitMs
        );


        continue;

      }


      throw new Error(
        "SPOTIFY_SEARCH_TEMPORARY"
      );

    }


    /*
    |--------------------------------------------------------------------------
    | ERROR NO RECUPERABLE
    |--------------------------------------------------------------------------
    */

    console.error(
      "Search Error:",
      response.status,
      errorBody
    );


    throw new Error(
      "SEARCH_ERROR"
    );

  }


  /*
  |--------------------------------------------------------------------------
  | VALIDAR DATA
  |--------------------------------------------------------------------------
  */

  if (
    !data
  ) {

    throw new Error(
      "SPOTIFY_SEARCH_TEMPORARY"
    );

  }


  const tracks =
    data.tracks
      ?.items ||
    [];


  if (
    !tracks.length
  ) {

    return null;

  }


  /*
  |--------------------------------------------------------------------------
  | RANKING
  |--------------------------------------------------------------------------
  */

  const queryTokens =
    tokenize(
      query
    );


  const ranked =
    tracks
      .map(
        track => {

          const artistText =
            track.artists
              .map(
                artist =>
                  artist.name
              )
              .join(" ");


          const candidateTokens =
            tokenize(
              track.name +
              " " +
              artistText
            );


          const artistTokens =
            tokenize(
              artistText
            );


          let score =
            0;


          for (
            const token
            of queryTokens
          ) {

            if (
              candidateTokens.includes(
                token
              )
            ) {

              score +=
                1;

            }

          }


          for (
            const token
            of queryTokens
          ) {

            if (
              artistTokens.includes(
                token
              )
            ) {

              score +=
                0.5;

            }

          }


          return {

            track,

            score

          };

        }
      )
      .sort(
        (
          a,
          b
        ) =>
          b.score -
          a.score
      );


  console.log(
    "🔎 Resultados Spotify:"
  );


  ranked
    .slice(
      0,
      5
    )
    .forEach(
      (
        result,
        index
      ) => {

        const artists =
          result.track.artists
            .map(
              artist =>
                artist.name
            )
            .join(", ");


        console.log(
          `${index + 1}.`,
          result.track.name,
          "-",
          artists,
          "| score:",
          result.score
        );

      }
    );


  return ranked[0].track;

}

/*
|--------------------------------------------------------------------------
| NORMALIZAR BÚSQUEDA
|--------------------------------------------------------------------------
*/

function tokenize(
  text
) {

  return normalizeText(
    text
  )
    .split(
      /\s+/
    )
    .filter(
      token =>
        token.length >
        1
    );

}


function normalizeText(
  text
) {

  return text
    .toLowerCase()
    .normalize(
      "NFD"
    )
    .replace(
      /[\u0300-\u036f]/g,
      ""
    )
    .replace(
      /[^a-z0-9\s]/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();

}


/*
|--------------------------------------------------------------------------
| SPOTIFY - DEVICES
|--------------------------------------------------------------------------
*/

async function getDevices(
  accessToken
) {

  const response =
    await fetch(
      "https://api.spotify.com/v1/me/player/devices",
      {

        headers: {

          Authorization:
            "Bearer " +
            accessToken

        }

      }
    );


  if (
    !response.ok
  ) {

    const error =
      await response.text();


    console.error(
      "Devices Error:",
      response.status,
      error
    );


    return [];

  }


  const data =
    await response.json();


  return (
    data.devices ||
    []
  );

}


/*
|--------------------------------------------------------------------------
| DEVICES CON RETRY
|--------------------------------------------------------------------------
*/

async function getDevicesWithRetry(
  accessToken
) {

  for (
    let attempt = 1;
    attempt <= 3;
    attempt++
  ) {

    const devices =
      await getDevices(
        accessToken
      );


    console.log(
      `📱 Devices intento ${attempt}:`,
      JSON.stringify(
        devices
      )
    );


    if (
      devices.length
    ) {

      return devices;

    }


    if (
      attempt <
      3
    ) {

      await sleep(
        attempt *
        600
      );

    }

  }


  return [];

}


/*
|--------------------------------------------------------------------------
| SELECCIONAR DEVICE
|--------------------------------------------------------------------------
*/

function selectDevice(
  devices
) {

  return (

    /*
    | Primero respetamos el device que Spotify
    | ya considera activo. Así evitamos transferencias
    | innecesarias que pueden interferir con PLAY.
    */

    devices.find(
      device =>
        device.type
          ?.toLowerCase() ===
          "smartphone"
        &&
        device.is_active
        &&
        !device.is_restricted
        &&
        device.id
    )

    ||

    devices.find(
      device =>
        device.is_active
        &&
        !device.is_restricted
        &&
        device.id
    )

    ||

    /*
    | Si no hay ninguno activo, preferimos
    | el teléfono Motorola del conductor.
    */

    devices.find(
      device =>
        device.name
          ?.toLowerCase()
          .includes(
            "motorola"
          )
        &&
        !device.is_restricted
        &&
        device.id
    )

    ||

    /*
    | Cualquier smartphone disponible
    */

    devices.find(
      device =>
        device.type
          ?.toLowerCase() ===
          "smartphone"
        &&
        !device.is_restricted
        &&
        device.id
    )

    ||

    /*
    | Cualquier device disponible
    */

    devices.find(
      device =>
        !device.is_restricted
        &&
        device.id
    )

  );

}


/*
|--------------------------------------------------------------------------
| PLAY ROBUSTO
|--------------------------------------------------------------------------
*/

async function playTrackResilient(
  accessToken,
  trackUri
) {

  let lastStatus =
    null;


  for (
    let attempt = 1;
    attempt <= 3;
    attempt++
  ) {

    console.log(
      `\n▶ Playback intento ${attempt}`
    );


    const devices =
      await getDevicesWithRetry(
        accessToken
      );


    const device =
      selectDevice(
        devices
      );


    if (
      !device
    ) {

      console.log(
        "⚠️ No apareció ningún dispositivo."
      );


      if (
        attempt <
        3
      ) {

        await sleep(
          1000
        );


        continue;
      }


      throw new Error(
        "NO_DEVICE"
      );

    }


    console.log(

      "🎯 Device:",

      device.name,

      "| active:",

      device.is_active,

      "| id:",

      device.id

    );


    /*
    |--------------------------------------------------------------------------
    | Si no está activo intentamos transferir.
    |--------------------------------------------------------------------------
    */

    if (
      !device.is_active
    ) {

      console.log(
        "🔄 Activando dispositivo..."
      );


      const transferred =
        await transferPlaybackSafe(
          accessToken,
          device.id
        );


      if (
        !transferred
      ) {

        console.log(
          "⚠️ No se pudo transferir el playback al teléfono."
        );

      }


      const active =
        await waitForDeviceActive(
          accessToken,
          device.id
        );


      if (
        !active
      ) {

        console.log(
          "⚠️ Spotify todavía no marca el teléfono como activo; intentaremos PLAY igualmente."
        );

      }

    }


    /*
    |--------------------------------------------------------------------------
    | PLAY
    |--------------------------------------------------------------------------
    */

    const result =
      await playTrackOnce(

        accessToken,

        device.id,

        trackUri

      );


    lastStatus =
      result.status;


    if (
      result.ok
    ) {

      console.log(
        "✅ Spotify aceptó PLAY. Verificando reproducción..."
      );


      const playback =
        await waitForTrackPlaying(
          accessToken,
          trackUri
        );


      if (
        playback
      ) {

        console.log(
          "✅ Playback realmente confirmado."
        );


        return {

          deviceName:
            playback.device
              ?.name ||
            device.name

        };

      }


      console.log(
        "⚠️ Spotify aceptó PLAY pero el tema todavía no está reproduciéndose. Reintentando..."
      );


      await sleep(
        700
      );


      continue;

    }


    console.log(

      "⚠️ Spotify respondió:",

      result.status,

      result.body

    );


    /*
    |--------------------------------------------------------------------------
    | Verificar si igualmente reprodujo.
    |--------------------------------------------------------------------------
    */

    await sleep(
      700
    );


    const playing =
      await getPlaybackStateSafe(
        accessToken
      );


    if (
      playing?.item?.uri ===
        trackUri
      &&
      playing?.is_playing ===
        true
    ) {

      console.log(
        "✅ Spotify devolvió error HTTP, pero el tema solicitado sí está reproduciéndose."
      );


      return {

        deviceName:
          playing.device
            ?.name ||
          device.name

      };

    }


    /*
    |--------------------------------------------------------------------------
    | Errores recuperables
    |--------------------------------------------------------------------------
    */

    if (
      [
        404,
        502,
        503
      ].includes(
        result.status
      )
    ) {

      console.log(
        "🔁 Error recuperable. Reintentando..."
      );


      await sleep(
        attempt *
        900
      );


      continue;

    }


    throw new Error(
      "PLAYBACK_ERROR"
    );

  }


  /*
  |--------------------------------------------------------------------------
  | COMPROBACIÓN FINAL
  |--------------------------------------------------------------------------
  */

  await sleep(
    700
  );


  const finalState =
    await getPlaybackStateSafe(
      accessToken
    );


  if (
    finalState
      ?.item
      ?.uri ===
      trackUri
    &&
    finalState
      ?.is_playing ===
      true
  ) {

    console.log(
      "✅ Playback confirmado en comprobación final."
    );


    return {

      deviceName:
        finalState.device
          ?.name ||
        "Spotify"

    };

  }


  console.error(
    "Playback falló después de reintentos. Último status:",
    lastStatus
  );


  throw new Error(
    "PLAYBACK_ERROR"
  );

}


/*
|--------------------------------------------------------------------------
| UN INTENTO PLAY
|--------------------------------------------------------------------------
*/

async function playTrackOnce(
  accessToken,
  deviceId,
  trackUri
) {

  const url =
    "https://api.spotify.com/v1/me/player/play" +
    "?device_id=" +
    encodeURIComponent(
      deviceId
    );


  const response =
    await fetch(
      url,
      {

        method:
          "PUT",

        headers: {

          Authorization:
            "Bearer " +
            accessToken,

          "Content-Type":
            "application/json"

        },

        body:
          JSON.stringify(
            {

              uris: [
                trackUri
              ]

            }
          )

      }
    );


  const body =
    await response.text();


  return {

    ok:
      response.ok,

    status:
      response.status,

    body

  };

}


/*
|--------------------------------------------------------------------------
| TRANSFER PLAYBACK
|--------------------------------------------------------------------------
*/

async function transferPlaybackSafe(
  accessToken,
  deviceId
) {

  const response =
    await fetch(
      "https://api.spotify.com/v1/me/player",
      {

        method:
          "PUT",

        headers: {

          Authorization:
            "Bearer " +
            accessToken,

          "Content-Type":
            "application/json"

        },

        body:
          JSON.stringify(
            {

              device_ids: [
                deviceId
              ],

              play:
                false

            }
          )

      }
    );


  if (
    !response.ok
  ) {

    const body =
      await response.text();


    console.log(

      "⚠️ Transfer respondió:",

      response.status,

      body

    );


    return false;

  }


  console.log(
    "✅ Transfer aceptado."
  );


  return true;

}


/*
|--------------------------------------------------------------------------
| ESPERAR DEVICE ACTIVO
|--------------------------------------------------------------------------
*/

async function waitForDeviceActive(
  accessToken,
  deviceId
) {

  for (
    let attempt = 1;
    attempt <= 6;
    attempt++
  ) {

    const devices =
      await getDevices(
        accessToken
      );


    const active =
      devices.find(
        device =>
          device.id ===
            deviceId
          &&
          device.is_active
      );


    if (
      active
    ) {

      console.log(
        "✅ Device activo confirmado:",
        active.name
      );


      return active;

    }


    await sleep(
      400
    );

  }


  return null;

}


/*
|--------------------------------------------------------------------------
| ESPERAR TRACK REPRODUCIÉNDOSE
|--------------------------------------------------------------------------
*/

async function waitForTrackPlaying(
  accessToken,
  trackUri
) {

  for (
    let attempt = 1;
    attempt <= 6;
    attempt++
  ) {

    const playback =
      await getPlaybackStateSafe(
        accessToken
      );


    console.log(
      `🔎 Verificación playback ${attempt}:`,
      playback
        ? JSON.stringify({
            uri:
              playback.item?.uri ||
              null,
            isPlaying:
              playback.is_playing,
            device:
              playback.device?.name ||
              null
          })
        : "sin estado"
    );


    if (
      playback?.item?.uri ===
        trackUri
      &&
      playback?.is_playing ===
        true
    ) {

      return playback;

    }


    await sleep(
      500
    );

  }


  return null;

}


/*
|--------------------------------------------------------------------------
| ESTADO ACTUAL SPOTIFY
|--------------------------------------------------------------------------
*/

async function getPlaybackStateSafe(
  accessToken
) {

  try {

    const response =
      await fetch(
        "https://api.spotify.com/v1/me/player",
        {

          headers: {

            Authorization:
              "Bearer " +
              accessToken

          }

        }
      );


    if (
      response.status ===
      204
    ) {

      return null;

    }


    if (
      !response.ok
    ) {

      console.log(
        "⚠️ No pudimos verificar playback:",
        response.status
      );


      return null;

    }


    return await response.json();


  } catch (error) {

    console.log(
      "⚠️ Error verificando playback:",
      error.message
    );


    return null;

  }

}


/*
|--------------------------------------------------------------------------
| SAME ORIGIN
|--------------------------------------------------------------------------
*/

function assertSameOrigin(
  request,
  url
) {

  const origin =
    request.headers.get(
      "Origin"
    );


  if (
    origin &&
    origin !==
      url.origin
  ) {

    throw new HttpError(
      403,
      "Origen no permitido."
    );

  }

}


/*
|--------------------------------------------------------------------------
| JSON BODY SEGURO
|--------------------------------------------------------------------------
*/

async function readJsonBody(
  request
) {

  const contentType =
    request.headers.get(
      "Content-Type"
    ) || "";


  if (
    !contentType
      .toLowerCase()
      .startsWith(
        "application/json"
      )
  ) {

    throw new HttpError(
      415,
      "Content-Type no permitido."
    );

  }


  const contentLength =
    Number(
      request.headers.get(
        "Content-Length"
      ) || 0
    );


  if (
    contentLength >
    MAX_BODY_BYTES
  ) {

    throw new HttpError(
      413,
      "Solicitud demasiado grande."
    );

  }


  const text =
    await request.text();


  const actualBytes =
    new TextEncoder()
      .encode(
        text
      )
      .byteLength;


  if (
    actualBytes >
    MAX_BODY_BYTES
  ) {

    throw new HttpError(
      413,
      "Solicitud demasiado grande."
    );

  }


  try {

    return JSON.parse(
      text
    );


  } catch {

    throw new HttpError(
      400,
      "JSON inválido."
    );

  }

}


/*
|--------------------------------------------------------------------------
| HTTP ERROR
|--------------------------------------------------------------------------
*/

class HttpError
  extends Error {

  constructor(
    status,
    message
  ) {

    super(
      message
    );


    this.status =
      status;

  }

}


/*
|--------------------------------------------------------------------------
| SECURITY HEADERS
|--------------------------------------------------------------------------
*/

function securityHeaders() {

  return {

    "X-Content-Type-Options":
      "nosniff",

    "X-Frame-Options":
      "DENY",

    "Referrer-Policy":
      "no-referrer",

    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=()",

    "Content-Security-Policy":
      "default-src 'self'; " +
      "connect-src 'self'; " +
      "img-src 'self' https: data:; " +
      "style-src 'self' 'unsafe-inline'; " +
      "script-src 'self' 'unsafe-inline'; " +
      "object-src 'none'; " +
      "base-uri 'none'; " +
      "frame-ancestors 'none'; " +
      "form-action 'self'",

    "Cache-Control":
      "no-store"

  };

}


/*
|--------------------------------------------------------------------------
| RESPONSE SEGURA
|--------------------------------------------------------------------------
*/

function secureResponse(
  body,
  options = {}
) {

  const headers =
    new Headers(
      options.headers ||
      {}
    );


  const security =
    securityHeaders();


  for (
    const [
      key,
      value
    ]
    of Object.entries(
      security
    )
  ) {

    headers.set(
      key,
      value
    );

  }


  return new Response(
    body,
    {

      ...options,

      headers

    }
  );

}


/*
|--------------------------------------------------------------------------
| HTML RESPONSE
|--------------------------------------------------------------------------
*/

function html(
  content
) {

  return secureResponse(
    content,
    {

      status:
        200,

      headers: {

        "Content-Type":
          "text/html; charset=UTF-8"

      }

    }
  );

}


/*
|--------------------------------------------------------------------------
| JSON RESPONSE
|--------------------------------------------------------------------------
*/

function json(
  data,
  status = 200
) {

  return secureResponse(
    JSON.stringify(
      data
    ),
    {

      status,

      headers: {

        "Content-Type":
          "application/json; charset=UTF-8"

      }

    }
  );

}


/*
|--------------------------------------------------------------------------
| SLEEP
|--------------------------------------------------------------------------
*/

function sleep(
  ms
) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );

}