require('dotenv').config();
const {
    Client, GatewayIntentBits, EmbedBuilder,
    ActivityType, REST, Routes, SlashCommandBuilder,
    AttachmentBuilder
} = require('discord.js');
const { createClient } = require('redis');
const express = require('express');
const cors    = require('cors');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers   // ← necesario para buscar miembros
    ]
});
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

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

// ── Redis ──────────────────────────────────────────────────────────────────
let redis = null;
async function connectRedis() {
    if (!REDIS_URL) { console.log('Sin Redis'); return; }
    redis = createClient({ url: REDIS_URL });
    redis.on('error', e => console.error('Redis:', e.message));
    await redis.connect();
    console.log('Redis conectado');
}

// ── Periodo keys ───────────────────────────────────────────────────────────
function getWeekKey(tipo) {
    const n = new Date(), jan = new Date(n.getFullYear(),0,1);
    const w = Math.ceil(((n-jan)/86400000+jan.getDay()+1)/7);
    return `lb:${tipo}:week:${n.getFullYear()}:${w}`;
}
function getMonthKey(tipo) {
    const n = new Date();
    return `lb:${tipo}:month:${n.getFullYear()}:${n.getMonth()+1}`;
}
function ttlWeek() {
    const n=new Date(), s=new Date(n);
    s.setDate(n.getDate()+(7-n.getDay())); s.setHours(23,59,59,0);
    return Math.max(1, Math.floor((s-n)/1000));
}
function ttlMonth() {
    const n=new Date(), l=new Date(n.getFullYear(),n.getMonth()+1,0,23,59,59);
    return Math.max(1, Math.floor((l-n)/1000));
}

// ── Stats ──────────────────────────────────────────────────────────────────
async function addStat(staff, tipo) {
    if (!staff || !tipo) return;
    const isSSCat = ['ss','ss-appeal','ss-clean','ss-notes'].includes(tipo);
    const cat   = isSSCat ? 'ss' : 'normal';
    const field = `${staff}:${tipo}`;
    if (redis) {
        await redis.hIncrBy(getWeekKey(cat),  field, 1); await redis.expire(getWeekKey(cat),  ttlWeek());
        await redis.hIncrBy(getMonthKey(cat), field, 1); await redis.expire(getMonthKey(cat), ttlMonth());
    } else {
        if (!global.lbMem) global.lbMem = {};
        ['week','month'].forEach(p => {
            const k = `${cat}_${p}`;
            if (!global.lbMem[k]) global.lbMem[k] = {};
            global.lbMem[k][field] = (global.lbMem[k][field]||0)+1;
        });
    }
}

async function getLB(cat, periodo) {
    const key = periodo === 'week' ? getWeekKey(cat) : getMonthKey(cat);
    let raw = {};
    if (redis) { raw = await redis.hGetAll(key) || {}; }
    else { raw = (global.lbMem||{})[`${cat}_${periodo}`] || {}; }
    const result = {};
    for (const [field, val] of Object.entries(raw)) {
        const idx   = field.indexOf(':');
        const staff = field.slice(0, idx);
        const tipo  = field.slice(idx+1);
        if (!result[staff]) result[staff] = {};
        result[staff][tipo] = (result[staff][tipo]||0) + (parseInt(val)||0);
    }
    return result;
}

// ── Auth ───────────────────────────────────────────────────────────────────
function auth(req, res, next) {
    if (req.headers['x-api-key'] !== SECRET_KEY) return res.status(401).json({ error: 'No autorizado' });
    next();
}
function s(v) { return (!v || String(v).trim() === '') ? '—' : String(v).slice(0,1024); }

// ── Base64 → Attachment ────────────────────────────────────────────────────
function toAttachment(b64, i) {
    try {
        const m = b64.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!m) return null;
        return new AttachmentBuilder(Buffer.from(m[2],'base64'), { name:`prueba_${i+1}.${m[1]}` });
    } catch(e) { return null; }
}

// ── Discord ID map — staffUsername → discordId ─────────────────────────────
const DISCORD_MAP_KEY = 'discord:map';

async function getDiscordMap() {
    if (redis) {
        const raw = await redis.hGetAll(DISCORD_MAP_KEY) || {};
        return raw;
    }
    return global.discordMap || {};
}

async function setDiscordId(staff, discordId) {
    if (redis) {
        await redis.hSet(DISCORD_MAP_KEY, staff, discordId);
    } else {
        if (!global.discordMap) global.discordMap = {};
        global.discordMap[staff] = discordId;
    }
}

async function resolveMention(staffNick) {
    // Primero busca en el mapa de IDs guardados
    const map = await getDiscordMap();
    if (map[staffNick]) return `<@${map[staffNick]}>`;
    // Fallback: busca por nombre en el guild
    try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const members = await guild.members.fetch();
        const lower = staffNick.toLowerCase();
        const found = members.find(m =>
            m.user.username.toLowerCase()    === lower ||
            m.displayName.toLowerCase()      === lower ||
            (m.nickname && m.nickname.toLowerCase() === lower)
        );
        return found ? `<@${found.user.id}>` : `**${staffNick}**`;
    } catch {
        return `**${staffNick}**`;
    }
}

// ── Skin ───────────────────────────────────────────────────────────────────
function skinUrl(nick) {
    return `https://mc-heads.net/avatar/${encodeURIComponent(nick)}/128`;
}

// ── Enviar embed + imágenes ────────────────────────────────────────────────
async function send(channelId, embed, imagenes) {
    if (!channelId) return { error: 'Canal no configurado' };
    try {
        const ch = await client.channels.fetch(channelId);
        await ch.send({ embeds:[embed] });
        const files = (imagenes||[]).map((b,i)=>toAttachment(b,i)).filter(Boolean);
        if (files.length > 0) await ch.send({ files });
        return { ok: true };
    } catch(e) { console.error('send:', e.message); return { error: e.message }; }
}

// ── Embed builders con fields (más anchos y legibles) ─────────────────────

function embedSancion(staff, nick, modalidad, tiempo, razon, pruebas) {
    return new EmbedBuilder()
        .setColor(0xFF4444)
        .setAuthor({ name: `Ejecutado por ${staff}`, iconURL: skinUrl(staff) })
        .setTitle('🚫 Nueva Sanción')
        .setThumbnail(skinUrl(nick || staff))
        .setDescription(
            `\`\`\`yaml\n` +
            `👤 Nick: ${s(nick)}\n` +
            `📋 Razón: ${s(razon)}\n` +
            `⏱️ Tiempo: ${s(tiempo)}\n` +
            `🎮 Modalidad: ${s(modalidad)}\n\n` +
            `🔗 Pruebas: ${s(pruebas) || '—'}\n` +
            `\`\`\``
        )
        .setTimestamp()
        .setFooter({ text: 'Tilted Staff' });
}

function embedSS(staff, nick, modalidad, razon, pruebas, tiempo) {
    return new EmbedBuilder()
        .setColor(0x9B59B6)
        .setAuthor({ name: `Ejecutado por ${staff}`, iconURL: skinUrl(staff) })
        .setTitle('🖥️ SS Ban')
        .setThumbnail(skinUrl(nick || staff))
        .setDescription(
            `\`\`\`yaml\n` +
            `👤 Nick: ${s(nick)}\n` +
            `🎮 Modalidad: ${s(modalidad)}\n` +
            `⏱️ Tiempo: ${s(tiempo) || 'Permanente'}\n` +
            `📋 Razón: ${s(razon)}\n` +
            `🔗 Pruebas: ${s(pruebas) || '—'}\n` +
            `\`\`\``
        )
        .setTimestamp()
        .setFooter({ text: 'Tilted Staff • SS Ban' });
}

function embedRB(staff, modalidad, nick, nick2, razon, tipo) {
    return new EmbedBuilder()
        .setColor(tipo === 'online' ? 0x2ECC71 : 0xE74C3C)
        .setAuthor({ name: `Ejecutado por ${staff}`, iconURL: skinUrl(staff) })
        .setTitle(`🔄 Rollback ${tipo==='online' ? '🟢 Online' : '🔴 Offline'}`)
        .setThumbnail(skinUrl(nick || staff))
        .setDescription(
            `\`\`\`yaml\n` +
            `👤 Nick: ${s(nick)}\n` +
            `👥 Nick involucrado: ${s(nick2)}\n` +
            `🎮 Modalidad: ${s(modalidad)}\n\n` +
            `📋 Razón: ${s(razon)}\n` +
            `\`\`\``
        )
        .setTimestamp()
        .setFooter({ text: 'Tilted Staff' });
}

function embedMute(staff, nick, modalidad, tiempo, razon, pruebas) {
    return new EmbedBuilder()
        .setColor(0xF39C12)
        .setAuthor({ name: `Ejecutado por ${staff}`, iconURL: skinUrl(staff) })
        .setTitle('🔇 Nuevo Mute')
        .setThumbnail(skinUrl(nick || staff))
        .setDescription(
            `\`\`\`yaml\n` +
            `👤 Nick: ${s(nick)}\n` +
            `📋 Razón: ${s(razon)}\n` +
            `⏱️ Tiempo: ${s(tiempo)}\n` +
            `🎮 Modalidad: ${s(modalidad)}\n\n` +
            `🔗 Pruebas: ${s(pruebas) || '—'}\n` +
            `\`\`\``
        )
        .setTimestamp()
        .setFooter({ text: 'Tilted Staff' });
}

// ── Leaderboard ────────────────────────────────────────────────────────────
async function buildLBEmbed(data, cat, periodo) {
    const label    = periodo==='week' ? 'Semanal' : 'Mensual';
    const reset    = periodo==='week' ? 'Resetea cada domingo' : 'Resetea cada fin de mes';
    const catLabel = cat==='ss' ? 'SS Staff' : 'Staff';
    const color    = cat==='ss' ? 0x9B59B6 : (periodo==='week' ? 0xF39C12 : 0x5865F2);
    const entries  = Object.entries(data);

    if (!entries.length) return new EmbedBuilder()
        .setColor(color)
        .setTitle(`🏆 Ranking ${catLabel} — ${label}`)
        .setDescription('```\nNo hay acciones registradas aún.\n```')
        .setFooter({ text: `Tilted Staff  •  ${reset}` });

    entries.sort((a,b) =>
        Object.values(b[1]).reduce((s,v)=>s+v,0) -
        Object.values(a[1]).reduce((s,v)=>s+v,0)
    );

    const medals = ['🥇','🥈','🥉'];
    const mentions = await Promise.all(entries.map(([staff]) => resolveMention(staff)));

    const lines = entries.map(([staff, stats], i) => {
        const total  = Object.values(stats).reduce((s,v)=>s+v,0);
        const medal  = medals[i] || `**#${i+1}**`;
        const mention = mentions[i];

        if (cat==='ss') {
            const ban    = stats['ss']       || 0;
            const appeal = stats['ss-appeal']|| 0;
            const clean  = stats['ss-clean'] || 0;
            const notes  = stats['ss-notes'] || 0;
            return (
                `${medal} ${mention} — **${total}** acciones\n` +
                `> 🚫 \`${ban}\` ban  •  📨 \`${appeal}\` appeal  •  ✅ \`${clean}\` clean  •  📝 \`${notes}\` notes`
            );
        }
        const bans  = stats.sanciones  || 0;
        const rbs   = stats.rollbacks  || 0;
        const mutes = stats.mutes      || 0;
        return (
            `${medal} ${mention} — **${total}** acciones\n` +
            `> 🚫 \`${bans}\` bans  •  🔄 \`${rbs}\` rollbacks  •  🔇 \`${mutes}\` mutes`
        );
    }).join('\n\n');

    return new EmbedBuilder()
        .setColor(color)
        .setTitle(`🏆 Ranking ${catLabel} — ${label}`)
        .setDescription(lines)
        .setTimestamp()
        .setFooter({ text: `Tilted Staff  •  ${reset}` });
}

// ── Slash commands ─────────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const cmd = interaction.commandName;

    if (['top-semanal','top-mensual','top-ss-semanal','top-ss-mensual'].includes(cmd)) {
        const periodo = cmd.includes('semanal') ? 'week' : 'month';
        const cat     = cmd.includes('ss') ? 'ss' : 'normal';
        const data    = await getLB(cat, periodo);
        await interaction.reply({ embeds: [await buildLBEmbed(data, cat, periodo)] });
    }

    if (cmd === 'vincular') {
        const usuario = interaction.options.getString('usuario');
        const discordId = interaction.user.id;
        await setDiscordId(usuario, discordId);
        await interaction.reply({
            content: `✅ Tu usuario **${usuario}** fue vinculado a ${interaction.user}. Aparecerás mencionado en el top.`,
            ephemeral: true
        });
    }

    if (cmd === 'sync-staff') {
        await interaction.deferReply({ ephemeral: true });
        try {
            const guild = await client.guilds.fetch(GUILD_ID);
            const members = await guild.members.fetch();
            const map = await getDiscordMap();
            let linked = 0;

            for (const [, member] of members) {
                const lower   = member.user.username.toLowerCase();
                const display = member.displayName.toLowerCase();
                const nick    = (member.nickname || '').toLowerCase();

                // Buscar si algún staff del mapa coincide con este miembro
                for (const staffName of Object.keys(map)) {
                    const sl = staffName.toLowerCase();
                    if (sl === lower || sl === display || sl === nick) {
                        const currentId = map[staffName];
                        if (currentId !== member.user.id) {
                            await setDiscordId(staffName, member.user.id);
                            linked++;
                        }
                    }
                }
            }

            await interaction.editReply(`✅ Sync completo. **${linked}** staff vinculados automáticamente.`);
        } catch(e) {
            console.error('sync-staff:', e.message);
            await interaction.editReply(`❌ Error: ${e.message}`);
        }
    }
});

// ── Health check ───────────────────────────────────────────────────────────
app.get('/', (req,res) => res.json({ status:'online', bot:client.user?.tag||'conectando...' }));

// ── Link Discord ID ────────────────────────────────────────────────────────
app.post('/link-discord', auth, async (req,res) => {
    const { staff, discordId } = req.body;
    if (!staff || !discordId) return res.json({ error: 'Faltan datos' });
    await setDiscordId(staff, discordId);
    res.json({ ok: true, message: `${staff} vinculado a <@${discordId}>` });
});

app.get('/discord-map', auth, async (req,res) => {
    const map = await getDiscordMap();
    res.json(map);
});

// ── Endpoints ──────────────────────────────────────────────────────────────
app.post('/sancion', auth, async (req,res) => {
    const { staff, modalidad, razon, tiempo, nick, pruebas, imagenes } = req.body;
    await addStat(staff, 'sanciones');
    res.json(await send(CHANNEL_SANCIONES, embedSancion(staff,nick,modalidad,tiempo,razon,pruebas), imagenes));
});

app.post('/ss', auth, async (req,res) => {
    const { staff, modalidad, razon, nick, pruebas, imagenes, tiempo } = req.body;
    await addStat(staff, 'ss');
    if (!CHANNEL_SS) return res.json({ error: 'Canal no configurado' });
    try {
        const ch = await client.channels.fetch(CHANNEL_SS);
        const msg = await ch.send({ embeds: [embedSS(staff,nick,modalidad,razon,pruebas,tiempo)] });
        const files = (imagenes||[]).map((b,i)=>toAttachment(b,i)).filter(Boolean);
        if (files.length > 0) await ch.send({ files });
        await msg.react('✅');
        await msg.react('❌');
        res.json({ ok: true });
    } catch(e) { console.error('ss:', e.message); res.json({ error: e.message }); }
});

app.post('/rollback', auth, async (req,res) => {
    const { staff, modalidad, nick, nick2, razon, tipo, imagenes } = req.body;
    await addStat(staff, 'rollbacks');
    res.json(await send(CHANNEL_ROLLBACKS, embedRB(staff,modalidad,nick,nick2,razon,tipo), imagenes));
});

app.post('/mute', auth, async (req,res) => {
    const { staff, modalidad, nick, tiempo, razon, pruebas, imagenes } = req.body;
    await addStat(staff, 'mutes');
    res.json(await send(CHANNEL_MUTES, embedMute(staff,nick,modalidad,tiempo,razon,pruebas), imagenes));
});

app.post('/unbaneo', auth, async (req,res) => {
    const { staff, nick, razon, modalidad, imagenes } = req.body;
    const embed = new EmbedBuilder()
        .setColor(0x43B581)
        .setAuthor({ name: `Ejecutado por ${staff}`, iconURL: skinUrl(staff) })
        .setTitle('🔓 Unbaneo')
        .setThumbnail(skinUrl(nick || staff))
        .addFields(
            { name: '👤 Nick',      value: s(nick),      inline: true  },
            { name: '🎮 Modalidad', value: s(modalidad), inline: true  },
            { name: '📋 Razón',     value: s(razon),     inline: false },
        )
        .setTimestamp()
        .setFooter({ text: `Tilted Staff` });
    res.json(await send(CHANNEL_SANCIONES, embed, imagenes));
});

app.post('/ss-appeal', auth, async (req,res) => {
    const { staff, nick, razon, modalidad, pruebas, imagenes } = req.body;
    await addStat(staff, 'ss-appeal');
    const embed = new EmbedBuilder()
        .setColor(0xE67E22)
        .setAuthor({ name: `Ejecutado por ${staff}`, iconURL: skinUrl(staff) })
        .setTitle('📨 SS Appeal')
        .setThumbnail(skinUrl(nick || staff))
        .addFields(
            { name: '👤 Nick',       value: s(nick),       inline: true  },
            { name: '🎮 Modalidad',  value: s(modalidad),  inline: true  },
            { name: '📋 Razón',      value: s(razon),      inline: false },
            { name: '🔗 Pruebas',    value: s(pruebas) || '—', inline: false },
        )
        .setTimestamp()
        .setFooter({ text: `Tilted Staff • SS Appeal` });
    res.json(await send(CHANNEL_SS, embed, imagenes));
});

app.post('/ss-clean', auth, async (req,res) => {
    const { staff, nick, imagenes } = req.body;
    await addStat(staff, 'ss-clean');
    const embed = new EmbedBuilder()
        .setColor(0x43B581)
        .setAuthor({ name: `Ejecutado por ${staff}`, iconURL: skinUrl(staff) })
        .setTitle('✅ SS Clean')
        .setThumbnail(skinUrl(nick || staff))
        .addFields(
            { name: '👤 Nick', value: s(nick), inline: true },
        )
        .setTimestamp()
        .setFooter({ text: `Tilted Staff • SS Clean` });
    res.json(await send(CHANNEL_SS, embed, imagenes));
});

app.post('/ss-notes', auth, async (req,res) => {
    const { staff, nick, motivo, imagenes } = req.body;
    await addStat(staff, 'ss-notes');
    const embed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setAuthor({ name: `Ejecutado por ${staff}`, iconURL: skinUrl(staff) })
        .setTitle('📝 SS Notes')
        .setThumbnail(skinUrl(nick || staff))
        .addFields(
            { name: '👤 Nick',    value: s(nick),   inline: true  },
            { name: '📋 Motivo', value: s(motivo), inline: false },
        )
        .setTimestamp()
        .setFooter({ text: `Tilted Staff • SS Notes` });
    res.json(await send(CHANNEL_SS, embed, imagenes));
});

// ── Vincular staff username → Discord ID ──────────────────────────────────
app.post('/vincular', auth, async (req,res) => {
    const { staff, discordId } = req.body;
    if (!staff || !discordId) return res.json({ error: 'Faltan datos' });
    await setDiscordId(staff, discordId);
    res.json({ ok: true, message: `${staff} vinculado a <@${discordId}>` });
});

app.get('/vincular', auth, async (req,res) => {
    const map = await getDiscordMap();
    res.json({ ok: true, map });
});

app.delete('/vincular', auth, async (req,res) => {
    const { staff } = req.body;
    if (!staff) return res.json({ error: 'Falta staff' });
    if (redis) { await redis.hDel(DISCORD_MAP_KEY, staff); }
    else { if (global.discordMap) delete global.discordMap[staff]; }
    res.json({ ok: true });
});

// ── Auto-vincular al entrar al servidor ───────────────────────────────────
async function tryAutoLink(member) {
    try {
        const map = await getDiscordMap();
        const lower = member.user.username.toLowerCase();
        const display = member.displayName.toLowerCase();
        const nick = (member.nickname || '').toLowerCase();

        // Buscar en el mapa si ya está vinculado
        const alreadyLinked = Object.values(map).includes(member.user.id);
        if (alreadyLinked) return;

        // Buscar coincidencia con algún staff registrado en el panel
        // El panel guarda usuarios en localStorage del cliente, pero el bot
        // puede intentar matchear por username/displayName/nickname
        const staffNames = Object.keys(map);
        // Si no hay staff en el mapa, no hay nada con qué comparar aún
        // El match se hace cuando algún staff ya fue registrado manualmente
        // y un nuevo miembro entra con el mismo nombre
        for (const staffName of staffNames) {
            if (
                staffName.toLowerCase() === lower ||
                staffName.toLowerCase() === display ||
                staffName.toLowerCase() === nick
            ) {
                await setDiscordId(staffName, member.user.id);
                console.log(`Auto-vinculado: ${staffName} → ${member.user.id}`);
                return;
            }
        }
    } catch(e) { console.error('tryAutoLink:', e.message); }
}

client.on('guildMemberAdd', async member => {
    await tryAutoLink(member);
});

// ── Registrar slash commands ───────────────────────────────────────────────
async function registerCommands() {
    if (!CLIENT_ID || !GUILD_ID) { console.log('Sin CLIENT_ID/GUILD_ID'); return; }
    const commands = [
        new SlashCommandBuilder().setName('top-semanal').setDescription('Ranking semanal del staff (sanciones, rollbacks, mutes)').toJSON(),
        new SlashCommandBuilder().setName('top-mensual').setDescription('Ranking mensual del staff (sanciones, rollbacks, mutes)').toJSON(),
        new SlashCommandBuilder().setName('top-ss-semanal').setDescription('Ranking semanal de SS (bans, appeals, cleans, notes)').toJSON(),
        new SlashCommandBuilder().setName('top-ss-mensual').setDescription('Ranking mensual de SS (bans, appeals, cleans, notes)').toJSON(),
        new SlashCommandBuilder()
            .setName('vincular')
            .setDescription('Vincula tu usuario del panel con tu Discord')
            .addStringOption(o => o.setName('usuario').setDescription('Tu usuario del StaffPanel').setRequired(true))
            .toJSON(),
        new SlashCommandBuilder()
            .setName('sync-staff')
            .setDescription('Sincroniza todos los miembros del servidor con el mapa de Discord IDs (usar 1 vez)')
            .toJSON(),
    ];
    const rest = new REST({ version:'10' }).setToken(BOT_TOKEN);
    try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
        console.log('Slash commands registrados');
    } catch(e) { console.error('Commands:', e.message); }
}

app.post('/register-commands', auth, async (req,res) => {
    if (!CLIENT_ID || !GUILD_ID) return res.json({ error: 'Falta CLIENT_ID o GUILD_ID en .env' });
    const commands = [
        new SlashCommandBuilder().setName('top-semanal').setDescription('Ranking semanal del staff').toJSON(),
        new SlashCommandBuilder().setName('top-mensual').setDescription('Ranking mensual del staff').toJSON(),
        new SlashCommandBuilder().setName('top-ss-semanal').setDescription('Ranking semanal de SS').toJSON(),
        new SlashCommandBuilder().setName('top-ss-mensual').setDescription('Ranking mensual de SS').toJSON(),
    ];
    const rest = new REST({ version:'10' }).setToken(BOT_TOKEN);
    try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
        res.json({ ok: true, message: '4 slash commands registrados correctamente' });
    } catch(e) {
        console.error('register-commands:', e.message);
        res.json({ error: e.message });
    }
});

// ── Boot ───────────────────────────────────────────────────────────────────
client.once('ready', async () => {
    console.log(`Bot online: ${client.user.tag}`);
    client.user.setActivity('Tilted Staff', { type: ActivityType.Watching });
    await registerCommands();
});

connectRedis().then(() => {
    client.login(BOT_TOKEN).then(() => {
        app.listen(PORT, () => console.log(`API en puerto ${PORT}`));
    }).catch(err => { console.error('Login:', err.message); process.exit(1); });
});
