require('dotenv').config();
const {
    Client, GatewayIntentBits, EmbedBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ActivityType
} = require('discord.js');
const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');

// ── Cliente Discord ──
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages
    ]
});

client.once('ready', () => {
    console.log(`✅ Bot online: ${client.user.tag}`);
    client.user.setActivity('Tilted Staff', { type: ActivityType.Watching });
});

// ── Express ──
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Config desde .env ──
const PORT              = process.env.PORT             || 3000;
const BOT_TOKEN         = process.env.BOT_TOKEN;
const SECRET_KEY        = process.env.SECRET_KEY       || 'tilted2025';
const CHANNEL_SANCIONES = process.env.CHANNEL_SANCIONES; // sanciones + unbaneos
const CHANNEL_SS        = process.env.CHANNEL_SS;         // ss bans
const CHANNEL_ROLLBACKS = process.env.CHANNEL_ROLLBACKS;
const CHANNEL_MUTES     = process.env.CHANNEL_MUTES;

// ── Auth middleware ──
function auth(req, res, next) {
    if (req.headers['x-api-key'] !== SECRET_KEY)
        return res.status(401).json({ error: 'No autorizado' });
    next();
}

// ── Sanitizar strings — evitar embeds vacíos que Discord rechaza ──
function s(val) {
    if (!val || String(val).trim() === '') return '—';
    return String(val).slice(0, 1024); // límite de Discord por field
}

// ── Enviar embed a un canal ──
async function sendToChannel(channelId, embed, row) {
    if (!channelId) return { error: 'Canal no configurado en .env' };
    try {
        const ch = await client.channels.fetch(channelId);
        if (!ch) return { error: 'Canal no encontrado' };
        const payload = { embeds: [embed] };
        if (row && row.components.length > 0) payload.components = [row];
        await ch.send(payload);
        return { ok: true };
    } catch (e) {
        console.error('sendToChannel error:', e.message);
        return { error: e.message };
    }
}

// ── Botones: Ver Prueba (si hay link) + Confirmado + Rechazar ──
function makeButtons(pruebas) {
    const row = new ActionRowBuilder();
    const uid = crypto.randomUUID().slice(0, 8); // ID único sin colisiones

    if (pruebas && pruebas !== '—') {
        const link = pruebas.match(/https?:\/\/[^\s]+/);
        if (link) {
            row.addComponents(
                new ButtonBuilder()
                    .setLabel('🔗 Ver Prueba')
                    .setStyle(ButtonStyle.Link)
                    .setURL(link[0])
            );
        }
    }

    row.addComponents(
        new ButtonBuilder()
            .setCustomId(`ok_${uid}`)
            .setLabel('✅ Confirmado')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`no_${uid}`)
            .setLabel('❌ Rechazar')
            .setStyle(ButtonStyle.Danger)
    );

    return row;
}

// ── Manejar clicks en botones ──
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith('ok_') && !interaction.customId.startsWith('no_')) return;

    const ok    = interaction.customId.startsWith('ok_');
    const color = ok ? 0x43B581 : 0x747F8D;
    const label = ok ? '✅ Confirmado' : '❌ Rechazado';

    try {
        const originalEmbed = interaction.message.embeds[0];
        if (!originalEmbed) return;

        await interaction.update({
            embeds: [
                EmbedBuilder.from(originalEmbed)
                    .setColor(color)
                    .setFooter({ text: `${label} por ${interaction.user.username}` })
            ],
            components: []
        });
    } catch(e) {
        console.error('Button interaction error:', e.message);
    }
});

// ── Health check ──
app.get('/', (req, res) => res.json({
    status: 'online',
    bot: client.user?.tag || 'conectando...',
    canales: {
        sanciones_y_unbaneos: !!CHANNEL_SANCIONES,
        ss_bans:              !!CHANNEL_SS,
        rollbacks:            !!CHANNEL_ROLLBACKS,
        mutes:                !!CHANNEL_MUTES,
    }
}));

// ──────────────────────────────────────────────
//  POST /sancion — sanción normal
// ──────────────────────────────────────────────
app.post('/sancion', auth, async (req, res) => {
    const { staff, modalidad, comando, razon, pruebas, nick } = req.body;

    const embed = new EmbedBuilder()
        .setColor(0xFF4444)
        .setTitle('🚫 Nueva Sanción')
        .setDescription(`\`\`\`${s(comando)}\`\`\``)
        .addFields(
            { name: '👤 Staff',     value: s(staff),     inline: true },
            { name: '🎯 Nick',      value: s(nick),      inline: true },
            { name: '🎮 Modalidad', value: s(modalidad), inline: true },
            { name: '📋 Razón',     value: s(razon),     inline: false },
            { name: '🔗 Pruebas',   value: s(pruebas),   inline: false }
        )
        .setTimestamp()
        .setFooter({ text: 'Tilted Staff' });

    res.json(await sendToChannel(CHANNEL_SANCIONES, embed, makeButtons(pruebas)));
});

// ──────────────────────────────────────────────
//  POST /ss — SS Ban (canal separado)
// ──────────────────────────────────────────────
app.post('/ss', auth, async (req, res) => {
    const { staff, modalidad, comando, razon, pruebas, nick, resultado } = req.body;

    const embed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle('🖥️ SS Ban')
        .setDescription(`\`\`\`${s(comando)}\`\`\``)
        .addFields(
            { name: '👤 Staff',     value: s(staff),      inline: true },
            { name: '🎯 Nick',      value: s(nick),       inline: true },
            { name: '🎮 Modalidad', value: s(modalidad),  inline: true },
            { name: '📋 Razón SS',  value: s(razon),      inline: false },
            { name: '🔍 Resultado', value: s(resultado),  inline: false },
            { name: '🔗 Pruebas',   value: s(pruebas),    inline: false }
        )
        .setTimestamp()
        .setFooter({ text: 'Tilted Staff • SS Ban' });

    res.json(await sendToChannel(CHANNEL_SS, embed, makeButtons(pruebas)));
});

// ──────────────────────────────────────────────
//  POST /rollback
// ──────────────────────────────────────────────
app.post('/rollback', auth, async (req, res) => {
    const { staff, modalidad, nick, nick2, razon, tipo, pruebas } = req.body;

    const embed = new EmbedBuilder()
        .setColor(0x7289DA)
        .setTitle(`🔄 Rollback ${tipo === 'online' ? '🟢 Online' : '🔴 Offline'}`)
        .addFields(
            { name: '👤 Staff',            value: s(staff),     inline: true },
            { name: '🎮 Modalidad',        value: s(modalidad), inline: true },
            { name: '\u200B',              value: '\u200B',      inline: true },
            { name: '🎯 Nick afectado',    value: s(nick),      inline: true },
            { name: '🤝 Nick involucrado', value: s(nick2),     inline: true },
            { name: '\u200B',              value: '\u200B',      inline: true },
            { name: '📋 Razón',            value: s(razon),     inline: false },
            { name: '🔗 Pruebas',          value: s(pruebas),   inline: false }
        )
        .setTimestamp()
        .setFooter({ text: 'Tilted Staff' });

    res.json(await sendToChannel(CHANNEL_ROLLBACKS, embed, makeButtons(pruebas)));
});

// ──────────────────────────────────────────────
//  POST /mute
// ──────────────────────────────────────────────
app.post('/mute', auth, async (req, res) => {
    const { staff, modalidad, comando, nick, tiempo, razon, pruebas } = req.body;

    const embed = new EmbedBuilder()
        .setColor(0xF39C12)
        .setTitle('🔇 Nuevo Mute')
        .setDescription(`\`\`\`${s(comando)}\`\`\``)
        .addFields(
            { name: '👤 Staff',     value: s(staff),     inline: true },
            { name: '🎯 Nick',      value: s(nick),      inline: true },
            { name: '🎮 Modalidad', value: s(modalidad), inline: true },
            { name: '⏱️ Tiempo',    value: s(tiempo),    inline: true },
            { name: '📋 Razón',     value: s(razon),     inline: false },
            { name: '🔗 Pruebas',   value: s(pruebas),   inline: false }
        )
        .setTimestamp()
        .setFooter({ text: 'Tilted Staff' });

    res.json(await sendToChannel(CHANNEL_MUTES, embed, makeButtons(pruebas)));
});

// ──────────────────────────────────────────────
//  POST /unbaneo — mismo canal que sanciones
// ──────────────────────────────────────────────
app.post('/unbaneo', auth, async (req, res) => {
    const { staff, nick, razon, modalidad, pruebas } = req.body;

    const embed = new EmbedBuilder()
        .setColor(0x43B581)
        .setTitle('🔓 Unbaneo')
        .addFields(
            { name: '👤 Staff',     value: s(staff),     inline: true },
            { name: '🎯 Nick',      value: s(nick),      inline: true },
            { name: '🎮 Modalidad', value: s(modalidad), inline: true },
            { name: '📋 Razón',     value: s(razon),     inline: false },
            { name: '🔗 Pruebas',   value: s(pruebas),   inline: false }
        )
        .setTimestamp()
        .setFooter({ text: 'Tilted Staff' });

    // ← mismo canal que sanciones normales
    res.json(await sendToChannel(CHANNEL_SANCIONES, embed, makeButtons(pruebas)));
});

// ── Arrancar: primero login, luego API ──
client.login(BOT_TOKEN).then(() => {
    app.listen(PORT, () => console.log(`🌐 API en puerto ${PORT}`));
}).catch(err => {
    console.error('❌ Login error:', err.message);
    process.exit(1);
});
