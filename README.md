# Tilted Staff Bot 🤖

Bot de Discord con 4 canales separados.

## Canales

| Ruta API     | Canal               | Color   | Incluye        |
|--------------|---------------------|---------|----------------|
| POST /sancion | CHANNEL_SANCIONES  | 🔴 Rojo  | Sanciones normales |
| POST /unbaneo | CHANNEL_SANCIONES  | 🟢 Verde | Unbaneos (mismo canal) |
| POST /ss      | CHANNEL_SS         | 🟣 Morado| SS Bans        |
| POST /rollback| CHANNEL_ROLLBACKS  | 🔵 Azul  | Rollbacks      |
| POST /mute    | CHANNEL_MUTES      | 🟠 Naranja| Mutes         |

---

## Setup

### 1. Crear bot en Discord
1. https://discord.com/developers/applications → **New Application**
2. Sección **Bot** → **Reset Token** → copiarlo
3. Activar los 3 **Privileged Gateway Intents**
4. **OAuth2 → URL Generator**
   - Scopes: `bot`
   - Permisos: `Send Messages`, `Embed Links`, `Read Message History`
5. Abrir la URL generada e invitar el bot al server

### 2. Obtener Channel IDs
Discord → Configuración → Apariencia → **Modo desarrollador** ON
Clic derecho en cada canal → **Copiar ID** (necesitás 4)

### 3. Subir a Railway
1. Subir esta carpeta a GitHub
2. railway.app → **New Project → Deploy from GitHub**
3. En **Variables** agregar:
```
BOT_TOKEN          = tu-token
SECRET_KEY         = tilted2025
CHANNEL_SANCIONES  = id-canal-sanciones-y-unbaneos
CHANNEL_SS         = id-canal-ss-bans
CHANNEL_ROLLBACKS  = id-canal-rollbacks
CHANNEL_MUTES      = id-canal-mutes
```
4. Railway te da una URL pública: `https://tilted-bot-production.up.railway.app`

---

## Código para la web de Sanciones

Pegar antes del `</script>` final del HTML:

```javascript
// ═══════════════════════════════════════════
//  TILTED BOT — Discord Integration
// ═══════════════════════════════════════════
const BOT_URL    = 'https://TU-URL.railway.app'; // ← cambiar
const BOT_SECRET = 'tilted2025';

async function notificarBot(ruta, datos) {
    try {
        const r = await fetch(BOT_URL + ruta, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': BOT_SECRET
            },
            body: JSON.stringify({
                ...datos,
                staff: window.currentUser || 'Staff'
            })
        });
        const json = await r.json();
        if (!json.ok) console.warn('Bot:', json.error);
    } catch(e) {
        console.warn('Bot offline:', e.message);
    }
}
```

### Al final de generarSancion():
```javascript
// Detectar si es SS ban por las keywords de la razón
const razonVal = document.getElementById('s-proofs').value;
const comandoVal = document.getElementById('s-comando').value;
const esSSBan = isSSBan(razonVal); // función ya existe en la web

if (esSSBan) {
    notificarBot('/ss', {
        nick: nickDelComando,
        modalidad: modActual,
        comando: comandoVal,
        razon: razonVal,
        pruebas: razonVal
    });
} else {
    notificarBot('/sancion', {
        nick: nickDelComando,
        modalidad: modActual,
        comando: comandoVal,
        razon: razonVal,
        pruebas: razonVal
    });
}
```

### Al final de generarRollback():
```javascript
notificarBot('/rollback', {
    nick: nickExtraido,
    nick2: nick2Extraido,
    modalidad: modActual,
    tipo: tipoRb,       // 'online' o 'offline'
    razon: razonExtraida,
    pruebas: pruebasExtraidas
});
```

### Al final de generarMute():
```javascript
notificarBot('/mute', {
    nick: nickExtraido,
    modalidad: modActual,
    comando: comandoVal,
    tiempo: tiempoExtraido,
    razon: razonExtraida,
    pruebas: pruebasExtraidas
});
```

### Al final de generarUnbaneo():
```javascript
notificarBot('/unbaneo', {
    nick: nickExtraido,
    modalidad: modActual,
    razon: razonExtraida,
    pruebas: pruebasExtraidas
});
```

---

## Verificar que funciona

Abrir: `https://TU-URL.railway.app/`

Respuesta esperada:
```json
{
  "status": "online",
  "bot": "TiltedBot#1234",
  "canales": {
    "sanciones_y_unbaneos": true,
    "ss_bans": true,
    "rollbacks": true,
    "mutes": true
  }
}
```
