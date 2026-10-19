import 'dotenv/config';
import pg from 'pg';
export const {GUILD_ID,DISCORD_TOKEN,DISCORD_CLIENT_ID,DATABASE_URL}=process.env;
for(const k of ['GUILD_ID','DISCORD_TOKEN','DISCORD_CLIENT_ID','DATABASE_URL']) if(!process.env[k]) throw Error(`Missing ${k}`);
export const db=new pg.Pool({connectionString:DATABASE_URL,ssl:{rejectUnauthorized:false}});
export async function settings(){const r=await db.query('SELECT data FROM settings WHERE guild_id=$1',[GUILD_ID]);return r.rows[0]?.data||{};}
export async function audit(actor,action,detail={}){await db.query('INSERT INTO audit_logs(guild_id,actor_id,action,detail) VALUES($1,$2,$3,$4)',[GUILD_ID,actor,action,JSON.stringify(detail)]);}
export function canManage(interaction){return interaction.memberPermissions?.has('ManageGuild')||interaction.guild?.ownerId===interaction.user.id;}
export function instructor(interaction,s){return canManage(interaction)|| (s.instructorRoles||[]).some(id=>interaction.member?.roles?.cache?.has(id));}
export async function logTo(guild,s,key,message){const id=s[key];if(!id)return;try{const ch=await guild.channels.fetch(id);if(ch?.isTextBased())await ch.send({content:message,allowedMentions:{parse:[]}});}catch(e){console.error('Log send failed',key,e.message);}}

export function hasAllowedRole(interaction,roleIds){
 if(interaction.guild?.ownerId===interaction.user.id)return true;
 const allowed=Array.isArray(roleIds)?roleIds:[];
 return allowed.some(id=>interaction.member?.roles?.cache?.has(id)|| (Array.isArray(interaction.member?.roles)&&interaction.member.roles.includes(id)));
}
