require('dotenv').config();
const {
    Client, GatewayIntentBits, EmbedBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ActivityType, REST, Routes, SlashCommandBuilder,
    AttachmentBuilder
} = require('discord.js');
const { createClient } = require('redis');
const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');

// ── Discord Client ──
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// ── Express ──
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

// ── Config ──
const PORT              = process.env.PORT             || 3000;
const BOT_TOKEN         = process.env.BOT_TOKEN;
const SECRET_KEY        = process.env.SECRET_KEY       || 'tilted2025';
const CHANNEL_SANCIONES = process.env.CHANNEL_SANCIONES;
const CHANNEL_SS        = process.env.CHANNEL_SS;
const CHANNEL_ROLLBACKS = process.env.CHANNEL_ROLLBACKS;
const CHANNEL_MUTES     = process.env.CHANNEL_MUTES;
const CLIENT_ID         = process.env.CLIENT_ID;
const GUILD_ID          = process.env.GUILD_ID;
const REDIS_URL         = process.env.REDIS_URL;

// ── Redis ──
let redis = null;

async function connectRedis() {
    if (!REDIS_URL) { console.log('⚠️  Sin Redis — stats en memoria'); return; }
    redis = createClient({ url: REDIS_URL });
    redis.on('error', e => console.error('Redis error:', e.message));
    await redis.connect();
    console.log('✅ Redis conectado');
}

// ── Claves de periodo ──
function getWeekKey() {
    const now  = new Date();
    const jan1 = new Date(now.getFullYear(), 0, 1);
    const week = Math.ceil(((now - jan1) / 86400000 + jan1.getDay() + 1) / 7);
    return `lb:week:${now.getFullYear()}:${week}`;
}

function getMonthKey() {
    const now = new Date();
    return `lb:month:${now.getFullYear()}:${now.getMonth() + 1}`;
}

// ── TTL hasta fin de semana (domingo 23:59) ──
function ttlToEndOfWeek() {
    const now    = new Date();
    const sunday = new Date(now);
    sunday.setDate(now.getDate() + (7 - now.getDay()));
    sunday.setHours(23, 59, 59, 0);
    return Math.floor((sunday - now) / 1000);
}

// ── TTL hasta fin de mes ──
function ttlToEndOfMonth() {
    const now      = new Date();
    const lastDay  = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    return Math.floor((lastDay - now) / 1000);
}

// ── Sumar stat ──
async function addStat(staff, tipo) {
    if (!staff) return;
    const tipos = ['sanciones', 'ss', 'rollbacks', 'mutes'];
    if (!tipos.includes(tipo)) return;

    const field = `${staff}:${tipo}`;

    if (redis) {
        const wKey = getWeekKey();
        const mKey = getMonthKey();

        await redis.hIncrBy(wKey, field, 1);
        await redis.expire(wKey, ttlToEndOfWeek());

        await redis.hIncrBy(mKey, field, 1);
        await redis.expire(mKey, ttlToEndOfMonth());
    } else {
        // Fallback en memoria
        if (!global.lbMem) global.lbMem = { week: {}, month: {} };
        global.lbMem.week[field]  = (global.lbMem.week[field]  || 0) + 1;
        global.lbMem.month[field] = (global.lbMem.month[field] || 0) + 1;
    }
}

// ── Leer leaderboard ──
async function getLB(periodo) {
    const key = periodo === 'week' ? getWeekKey() : getMonthKey();
    let raw = {};

    if (redis) {
        raw = await redis.hGetAll(key) || {};
    } else {
        raw = (global.lbMem || {})[periodo] || {};
    }

    // Convertir { 'W1ntt3r:sanciones': '3', 'W1ntt3r:ss': '1' } → { W1ntt3r: { sanciones:3, ss:1, ... } }
    const result = {};
    for (const [field, val] of Object.entries(raw)) {
        const [staff, tipo] = field.split(':');
        if (!result[staff]) result[staff] = { sanciones:0, ss:0, rollbacks:0, mutes:0 };
        result[staff][tipo] = parseInt(val) || 0;
    }
    return result;
}

// ── Auth ──
function auth(req, res, next) {
    if (req.headers['x-api-key'] !== SECRET_KEY)
        return res.status(401).json({ error: 'No autorizado' });
    next();
}

// ── Sanitizar ──
function s(val) {
    if (!val || String(val).trim() === '') return '—';
    return String(val).slice(0, 1024);
}

// ── Base64 → Attachment ──
function base64ToAttachment(b64, index) {
    try {
        const match = b64.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!match) return null;
        return new AttachmentBuilder(Buffer.from(match[2], 'base64'), { name: `prueba_${index + 1}.${match[1]}` });
    } catch(e) { return null; }
}

// ── Botones ──
function makeButtons() {
    const uid = crypto.randomUUID().slice(0, 8);
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ok_${uid}`).setLabel('✅ Confirmado').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`no_${uid}`).setLabel('❌ Rechazar').setStyle(ButtonStyle.Danger)
    );
}

// ── Enviar al canal ──
async function sendToChannel(channelId, embed, formato, imagenes) {
    if (!channelId) return { error: 'Canal no configurado' };
    try {
        const ch    = await client.channels.fetch(channelId);
        if (!ch) return { error: 'Canal no encontrado' };

        const files = (imagenes || []).map((b, i) => base64ToAttachment(b, i)).filter(Boolean);

        await ch.send({ embeds: [embed], components: [makeButtons()], files: files.length ? [files[0]] : [] });
        for (let i = 1; i < files.length; i++) await ch.send({ files: [files[i]] });
        if (formato) await ch.send({ content: formato });

        return { ok: true };
    } catch(e) {
        console.error('sendToChannel:', e.message);
        return { error: e.message };
    }
}

// ── Construir embed leaderboard ──
function buildLBEmbed(data, periodo) {
    const entries = Object.entries(data);
    const label   = periodo === 'week' ? '📅 Semanal' : '🗓️ Mensual';
    const reset   = periodo === 'week' ? 'Se resetea cada domingo' : 'Se resetea cada fin de mes';

    if (entries.length === 0) {
        return new EmbedBuilder()
            .setColor(0xF39C12)
            .setTitle(`🏆 Leaderboard ${label}`)
            .setDescription('No hay acciones registradas aún.')
            .setFooter({ text: reset });
    }

    entries.sort((a, b) => {
        const t = o => Object.values(o).reduce((s, v) => s + v, 0);
        return t(b[1]) - t(a[1]);
    });

    const medals = ['🥇', '🥈', '🥉'];
    const lines  = entries.map(([staff, stats], i) => {
        const total = Object.values(stats).reduce((s, v) => s + v, 0);
        const medal = medals[i] || `**${i + 1}.**`;
        return `${medal} **${staff}** — ${total} total  *(🚫 ${stats.sanciones}  🖥️ ${stats.ss}  🔄 ${stats.rollbacks}  🔇 ${stats.mutes})*`;
    }).join('\n');

    return new EmbedBuilder()
        .setColor(periodo === 'week' ? 0xF39C12 : 0x7289DA)
        .setTitle(`🏆 Leaderboard ${label}`)
        .setDescription(lines)
        .setTimestamp()
        .setFooter({ text: `Tilted Staff • ${reset}` });
}

// ── Interacciones ──
client.on('interactionCreate', async (interaction) => {

    // Botones
    if (interaction.isButton()) {
        if (!interaction.customId.startsWith('ok_') && !interaction.customId.startsWith('no_')) return;
        const ok    = interaction.customId.startsWith('ok_');
        const color = ok ? 0x43B581 : 0x747F8D;
        const label = ok ? '✅ Confirmado' : '❌ Rechazado';
        try {
            const orig = interaction.message.embeds[0];
            if (!orig) return;
            await interaction.update({
                embeds: [EmbedBuilder.from(orig).setColor(color).setFooter({ text: `${label} por ${interaction.user.username}` })],
                components: []
            });
        } catch(e) { console.error('Button:', e.message); }
        return;
    }

    // Slash commands
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'top-semanal') {
        const data  = await getLB('week');
        const embed = buildLBEmbed(data, 'week');
        await interaction.reply({ embeds: [embed] });
    }

    if (interaction.commandName === 'top-mensual') {
        const data  = await getLB('month');
        const embed = buildLBEmbed(data, 'month');
        await interaction.reply({ embeds: [embed] });
    }
});

// ── Health check ──
app.get('/', (req, res) => res.json({ status: 'online', bot: client.user?.tag || 'conectando...' }));

// ── Endpoints ──
app.post('/sancion', auth, async (req, res) => {
    const { staff, modalidad, razon, tiempo, nick, imagenes, formato } = req.body;
    await addStat(staff, 'sanciones');
    const embed = new EmbedBuilder().setColor(0xFF4444).setTitle('🚫 Nueva Sanción')
        .addFields(
            { name: '👤 Staff',     value: s(staff),     inline: true },
            { name: '🎯 Nick',      value: s(nick),      inline: true },
            { name: '🎮 Modalidad', value: s(modalidad), inline: true },
            { name: '⏱️ Tiempo',    value: s(tiempo),    inline: true },
            { name: '📋 Razón',     value: s(razon),     inline: false }
        ).setTimestamp().setFooter({ text: 'Tilted Staff' });
    res.json(await sendToChannel(CHANNEL_SANCIONES, embed, formato, imagenes));
});

app.post('/ss', auth, async (req, res) => {
    const { staff, modalidad, razon, nick, imagenes, formato } = req.body;
    await addStat(staff, 'ss');
    const embed = new EmbedBuilder().setColor(0x9B59B6).setTitle('🖥️ SS Ban')
        .addFields(
            { name: '👤 Staff',     value: s(staff),     inline: true },
            { name: '🎯 Nick',      value: s(nick),      inline: true },
            { name: '🎮 Modalidad', value: s(modalidad), inline: true },
            { name: '📋 Razón SS',  value: s(razon),     inline: false }
        ).setTimestamp().setFooter({ text: 'Tilted Staff • SS Ban' });
    res.json(await sendToChannel(CHANNEL_SS, embed, formato, imagenes));
});

app.post('/rollback', auth, async (req, res) => {
    const { staff, modalidad, nick, nick2, razon, tipo, imagenes, formato } = req.body;
    await addStat(staff, 'rollbacks');
    const embed = new EmbedBuilder().setColor(0x7289DA).setTitle(`🔄 Rollback ${tipo === 'online' ? '🟢 Online' : '🔴 Offline'}`)
        .addFields(
            { name: '👤 Staff',            value: s(staff),     inline: true },
            { name: '🎮 Modalidad',        value: s(modalidad), inline: true },
            { name: '\u200B',              value: '\u200B',      inline: true },
            { name: '🎯 Nick afectado',    value: s(nick),      inline: true },
            { name: '🤝 Nick involucrado', value: s(nick2),     inline: true },
            { name: '\u200B',              value: '\u200B',      inline: true },
            { name: '📋 Razón',            value: s(razon),     inline: false }
        ).setTimestamp().setFooter({ text: 'Tilted Staff' });
    res.json(await sendToChannel(CHANNEL_ROLLBACKS, embed, formato, imagenes));
});

app.post('/mute', auth, async (req, res) => {
    const { staff, modalidad, nick, tiempo, razon, imagenes, formato } = req.body;
    await addStat(staff, 'mutes');
    const embed = new EmbedBuilder().setColor(0xF39C12).setTitle('🔇 Nuevo Mute')
        .addFields(
            { name: '👤 Staff',     value: s(staff),     inline: true },
            { name: '🎯 Nick',      value: s(nick),      inline: true },
            { name: '🎮 Modalidad', value: s(modalidad), inline: true },
            { name: '⏱️ Tiempo',    value: s(tiempo),    inline: true },
            { name: '📋 Razón',     value: s(razon),     inline: false }
        ).setTimestamp().setFooter({ text: 'Tilted Staff' });
    res.json(await sendToChannel(CHANNEL_MUTES, embed, formato, imagenes));
});

app.post('/unbaneo', auth, async (req, res) => {
    const { staff, nick, razon, modalidad, imagenes, formato } = req.body;
    const embed = new EmbedBuilder().setColor(0x43B581).setTitle('🔓 Unbaneo')
        .addFields(
            { name: '👤 Staff',     value: s(staff),     inline: true },
            { name: '🎯 Nick',      value: s(nick),      inline: true },
            { name: '🎮 Modalidad', value: s(modalidad), inline: true },
            { name: '📋 Razón',     value: s(razon),     inline: false }
        ).setTimestamp().setFooter({ text: 'Tilted Staff' });
    res.json(await sendToChannel(CHANNEL_SANCIONES, embed, formato, imagenes));
});

// ── Registrar slash commands ──
async function registerCommands() {
    if (!CLIENT_ID || !GUILD_ID) { console.log('⚠️  Sin CLIENT_ID/GUILD_ID'); return; }
    const commands = [
        new SlashCommandBuilder()
            .setName('top-semanal')
            .setDescription('🏆 Ranking semanal del staff (se resetea cada domingo)')
            .toJSON(),
        new SlashCommandBuilder()
            .setName('top-mensual')
            .setDescription('🏆 Ranking mensual del staff (se resetea cada fin de mes)')
            .toJSON()
    ];
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
        console.log('✅ Slash commands registrados');
    } catch(e) { console.error('Commands error:', e.message); }
}

// ── Arrancar ──
client.once('ready', async () => {
    console.log(`✅ Bot online: ${client.user.tag}`);
    client.user.setActivity('Tilted Staff', { type: ActivityType.Watching });
    await registerCommands();
});

connectRedis().then(() => {
    client.login(BOT_TOKEN).then(() => {
        app.listen(PORT, () => console.log(`🌐 API en puerto ${PORT}`));
    }).catch(err => { console.error('Login error:', err.message); process.exit(1); });
});
