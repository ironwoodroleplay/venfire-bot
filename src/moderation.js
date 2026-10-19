import {SlashCommandBuilder,PermissionFlagsBits,ChannelType} from 'discord.js';
import {db,GUILD_ID,audit} from './common.js';
const user=o=>o.addUserOption(x=>x.setName('member').setDescription('Member').setRequired(true));
const reason=o=>o.addStringOption(x=>x.setName('reason').setDescription('Reason').setMaxLength(1000));
const memberCommand=(name,desc)=>user(new SlashCommandBuilder().setName(name).setDescription(desc));
const cmds=[];
for(const [name,desc] of [['ban','Ban a member'],['kick','Kick a member'],['softban','Ban then unban to clear recent messages'],['timeout','Timeout a member'],['untimeout','Remove timeout'],['warn','Warn a member'],['unwarn','Remove a warning'],['warnings','Show member warnings'],['modlogs','Show moderation history'],['nick','Change nickname'],['resetnick','Reset nickname'],['role','Manage member roles']]){
 let c=memberCommand(name,desc);
 if(name==='timeout')c.addIntegerOption(o=>o.setName('minutes').setDescription('Duration in minutes (1–40320)').setRequired(true).setMinValue(1).setMaxValue(40320));
 if(['ban','kick','softban','timeout','warn'].includes(name))c=reason(c);
 if(name==='unwarn')c.addIntegerOption(o=>o.setName('case').setDescription('Warning case ID').setRequired(true));
 if(name==='nick')c.addStringOption(o=>o.setName('nickname').setDescription('New nickname').setRequired(true).setMaxLength(32));
 if(name==='role')c.addRoleOption(o=>o.setName('role').setDescription('Role').setRequired(true)).addStringOption(o=>o.setName('action').setDescription('Add or remove').setRequired(true).addChoices({name:'Add',value:'add'},{name:'Remove',value:'remove'}));
 cmds.push(c);
}
cmds.push(new SlashCommandBuilder().setName('unban').setDescription('Unban a user').addStringOption(o=>o.setName('user_id').setDescription('Discord user ID').setRequired(true)).addStringOption(o=>o.setName('reason').setDescription('Reason')));
cmds.push(new SlashCommandBuilder().setName('modcase').setDescription('View moderation case').addIntegerOption(o=>o.setName('case').setDescription('Case ID').setRequired(true)));
cmds.push(new SlashCommandBuilder().setName('modcasevoid').setDescription('Void moderation case').addIntegerOption(o=>o.setName('case').setDescription('Case ID').setRequired(true)).addStringOption(o=>o.setName('reason').setDescription('Reason')));
cmds.push(new SlashCommandBuilder().setName('purge').setDescription('Delete recent messages').addIntegerOption(o=>o.setName('amount').setDescription('Number (1–100)').setMinValue(1).setMaxValue(100).setRequired(true)));
cmds.push(new SlashCommandBuilder().setName('slowmode').setDescription('Set channel slowmode').addIntegerOption(o=>o.setName('seconds').setDescription('Seconds (0–21600)').setMinValue(0).setMaxValue(21600).setRequired(true)));
for(const [name,desc] of [['lock','Lock current channel'],['unlock','Unlock current channel'],['lockdown','Lock all supported channels'],['unlockdown','Unlock all supported channels']])cmds.push(new SlashCommandBuilder().setName(name).setDescription(desc));
cmds.push(new SlashCommandBuilder().setName('logchannel').setDescription('Configure moderation log channel').addChannelOption(o=>o.setName('channel').setDescription('Text channel').addChannelTypes(ChannelType.GuildText).setRequired(true)));
cmds.push(new SlashCommandBuilder().setName('testlog').setDescription('Send a test moderation log'));
const permissions={ban:'BanMembers',unban:'BanMembers',softban:'BanMembers',kick:'KickMembers',timeout:'ModerateMembers',untimeout:'ModerateMembers',warn:'ModerateMembers',unwarn:'ModerateMembers',warnings:'ModerateMembers',modlogs:'ModerateMembers',modcase:'ModerateMembers',modcasevoid:'ManageGuild',purge:'ManageMessages',slowmode:'ManageChannels',lock:'ManageChannels',unlock:'ManageChannels',lockdown:'ManageChannels',unlockdown:'ManageChannels',role:'ManageRoles',nick:'ManageNicknames',resetnick:'ManageNicknames',logchannel:'ManageGuild',testlog:'ManageGuild'};
for(const c of cmds)c.setDefaultMemberPermissions(PermissionFlagsBits[permissions[c.name]]);
export const moderationCommands=cmds.map(c=>c.toJSON());
export const moderationNames=new Set(cmds.map(c=>c.name));
const fmt=x=>String(x||'').slice(0,1800);
async function dm(user,message){try{await user.send(message);}catch{}}
async function record(i,action,target,reason='',details={}){const r=await db.query('INSERT INTO moderation_cases(guild_id,action,target_id,actor_id,reason,details) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[GUILD_ID,action,target,i.user.id,reason||null,JSON.stringify(details)]);await audit(i.user.id,`moderation.${action}`,{case:r.rows[0].id,target,reason,...details});return r.rows[0].id;}
const hierarchy=(i,m)=>i.guild.ownerId===i.user.id||i.member.roles.highest.comparePositionTo(m.roles.highest)>0;
async function log(i,message){const r=await db.query('SELECT channel_id FROM moderation_config WHERE guild_id=$1',[GUILD_ID]);const id=r.rows[0]?.channel_id;if(!id)return;const ch=await i.guild.channels.fetch(id).catch(()=>null);if(ch?.isTextBased())await ch.send({content:fmt(message),allowedMentions:{parse:[]}}).catch(()=>{});}
const mention=id=>`<@${id}>`;
export async function handleModeration(i){
 const name=i.commandName,required=permissions[name];if(!i.memberPermissions?.has(PermissionFlagsBits[required]))return 'You lack the required moderation permission.';
 const target=i.options.getUser('member'),reason=i.options.getString('reason')||'No reason provided';let member=null;
 if(target&&['ban','kick','softban','timeout','untimeout','warn','nick','resetnick','role'].includes(name)){
  member=await i.guild.members.fetch(target.id).catch(()=>null);
  if(['kick','timeout','untimeout','nick','resetnick','role','warn'].includes(name)&&!member)return 'Member not found in this server.';
  if(member&&['ban','kick','softban','timeout','untimeout','nick','resetnick','role','warn'].includes(name)&&(!hierarchy(i,member)||member.id===i.guild.ownerId||member.id===i.user.id))return 'You cannot moderate this member due to role hierarchy.';
 }
 if(['ban','kick','softban','timeout','untimeout','warn','unwarn','unban','nick','resetnick','role'].includes(name)){
  let id=target?.id||i.options.getString('user_id');let extra='';
  if(name==='ban'||name==='softban'){if(!/^\d{17,20}$/.test(id))return 'Invalid user ID.';if(member&&!member.bannable)return 'I cannot ban that member.';if(target)await dm(target,`You have been ${name==='ban'?'banned':'softbanned'} from ${i.guild.name}. Reason: ${reason}`);await i.guild.members.ban(id,{deleteMessageSeconds:name==='softban'?86400:0,reason});if(name==='softban')await i.guild.members.unban(id,'Softban completed');}
  if(name==='unban'){if(!/^\d{17,20}$/.test(id))return 'Invalid user ID.';await i.guild.members.unban(id,reason);}
  if(name==='kick'){if(!member.kickable)return 'I cannot kick that member.';await dm(target,`You have been kicked from ${i.guild.name}. Reason: ${reason}`);await member.kick(reason);}
  if(name==='timeout'){if(!member.moderatable)return 'I cannot timeout that member.';const minutes=i.options.getInteger('minutes');await member.timeout(minutes*60000,reason);extra=` (${minutes} minutes)`;await dm(target,`You were timed out in ${i.guild.name} for ${minutes} minutes. Reason: ${reason}`);}
  if(name==='untimeout'){if(!member.moderatable)return 'I cannot remove this timeout.';await member.timeout(null,reason);await dm(target,`Your timeout in ${i.guild.name} was removed.`);}
  if(name==='warn'){await dm(target,`You received a warning in ${i.guild.name}. Reason: ${reason}`);}
  if(name==='unwarn'){const caseId=i.options.getInteger('case');const r=await db.query("UPDATE moderation_cases SET voided=TRUE,void_reason=$1 WHERE id=$2 AND guild_id=$3 AND target_id=$4 AND action='warn' AND voided=FALSE RETURNING id",[reason,caseId,GUILD_ID,id]);if(!r.rowCount)return 'No active warning with that case ID for this member.';extra=` (warning case #${caseId})`;}
  if(name==='nick'){const nick=i.options.getString('nickname');await member.setNickname(nick,reason);extra=` (${nick})`;}
  if(name==='resetnick')await member.setNickname(null,reason);
  if(name==='role'){const role=i.options.getRole('role'),action=i.options.getString('action');if(role.managed||role.position>=i.guild.members.me.roles.highest.position||i.guild.ownerId!==i.user.id&&role.position>=i.member.roles.highest.position)return 'That role is above your or my role hierarchy.';await member.roles[action==='add'?'add':'remove'](role,reason);extra=` (${action} ${role.name})`;}
  const caseId=await record(i,name,id,reason,{extra});await log(i,`Case #${caseId}: ${name} ${mention(id)} by ${mention(i.user.id)}${extra}. Reason: ${reason}`);return `${name} completed for ${mention(id)}${extra}. Case #${caseId}.`;
 }
 if(name==='warnings'||name==='modlogs'){const r=await db.query(`SELECT id,action,actor_id,reason,created_at,voided FROM moderation_cases WHERE guild_id=$1 AND target_id=$2 ${name==='warnings'?"AND action='warn' AND voided=FALSE":''} ORDER BY id DESC LIMIT 20`,[GUILD_ID,target.id]);return r.rows.map(x=>`#${x.id} ${x.action}${x.voided?' (void)':''} by ${mention(x.actor_id)} — ${fmt(x.reason)||'No reason'}`).join('\n')||'No moderation history.';}
 if(name==='modcase'||name==='modcasevoid'){const id=i.options.getInteger('case');if(name==='modcasevoid'){const r=await db.query('UPDATE moderation_cases SET voided=TRUE,void_reason=$1 WHERE id=$2 AND guild_id=$3 AND voided=FALSE RETURNING id',[reason,id,GUILD_ID]);if(!r.rowCount)return 'Case not found or already voided.';await audit(i.user.id,'moderation.casevoid',{id,reason});return `Case #${id} voided.`;}const r=await db.query('SELECT * FROM moderation_cases WHERE id=$1 AND guild_id=$2',[id,GUILD_ID]);if(!r.rowCount)return 'Case not found.';const x=r.rows[0];return `Case #${x.id}: ${x.action}\nTarget: ${mention(x.target_id)}\nModerator: ${mention(x.actor_id)}\nReason: ${x.reason||'None'}\nVoided: ${x.voided?'Yes':'No'}\nCreated: ${x.created_at.toISOString()}`;}
 if(name==='purge'){if(!i.channel.bulkDelete)return 'This channel does not support bulk deletion.';const amount=i.options.getInteger('amount');const removed=await i.channel.bulkDelete(amount,true);await record(i,'purge',i.channelId,`${removed.size} messages`);await log(i,`${mention(i.user.id)} purged ${removed.size} messages in <#${i.channelId}>.`);return `Deleted ${removed.size} messages (messages older than 14 days cannot be bulk deleted).`;}
 if(name==='slowmode'){if(!i.channel.setRateLimitPerUser)return 'Not supported in this channel.';const seconds=i.options.getInteger('seconds');await i.channel.setRateLimitPerUser(seconds);await record(i,'slowmode',i.channelId,`${seconds} seconds`);return `Slowmode set to ${seconds} seconds.`;}
 if(['lock','unlock','lockdown','unlockdown'].includes(name)){const locked=name==='lock'||name==='lockdown',all=name==='lockdown'||name==='unlockdown';const channels=all?[...(await i.guild.channels.fetch()).values()].filter(Boolean):[i.channel];let success=0,failed=0;for(const ch of channels){if(![ChannelType.GuildText,ChannelType.GuildAnnouncement,ChannelType.GuildForum].includes(ch.type))continue;try{await ch.permissionOverwrites.edit(i.guild.roles.everyone,{SendMessages:locked?false:null,SendMessagesInThreads:locked?false:null,CreatePublicThreads:locked?false:null,CreatePrivateThreads:locked?false:null},{reason:`${name} by ${i.user.tag}`});success++;}catch{failed++;}}await record(i,name,i.guildId,`${success} channels; ${failed} failed`);await log(i,`${name} by ${mention(i.user.id)}: ${success} channels updated, ${failed} failed.`);return `${name} completed: ${success} channels updated, ${failed} failed.`;}
 if(name==='logchannel'){const ch=i.options.getChannel('channel');await db.query('INSERT INTO moderation_config(guild_id,channel_id) VALUES($1,$2) ON CONFLICT(guild_id) DO UPDATE SET channel_id=EXCLUDED.channel_id',[GUILD_ID,ch.id]);return `Moderation logs configured in <#${ch.id}>.`;}
 if(name==='testlog'){await log(i,`Moderation test log by ${mention(i.user.id)}.`);return 'Test moderation log sent if a logging channel is configured.';}
 return 'Unknown moderation command.';
}
