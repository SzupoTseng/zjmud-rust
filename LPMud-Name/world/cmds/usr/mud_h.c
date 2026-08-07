#include <ansi.h>
inherit F_CLEAN_UP;
inherit F_DBASE;
inherit F_SAVE;
void create()
{
	seteuid(ROOT_UID);
	set("channel_id", "HTML精灵");
	CHANNEL_D->do_channel( this_object(), "sys", "HTML精灵已经启动。");
	set_heart_beat(10);
}
int main(object me,string arg)
{
if(me->query("web"))
write(ZJOBLONG+ZJSIZE(25)+"http://"+NAME_PAY+":5004/mudh.html"+ZJBR+ZJSIZE(15)+HIG+ESA+"[u:http://"+NAME_PAY+":5004/mudh.html]MUD网站[点击跳转]"+NOR+"\n");
else
write(ZJOBLONG+ZJSIZE(25)+"hhttp://"+NAME_PAY+":5004/mudh.html "ZJBR"[MUD网站，游览器访问】"+NOR+"\n");
return 1;
}
void heart_beat()
{
string text;
mixed *sj;
string h="",mc,name,exp,id,read,line,*lines,*html;
html=({});
if(!file_size("/cmds/usr/top_exp.txt"))
return;
read=read_file("/cmds/usr/top_exp.txt");
lines=explode(read,"\n");
foreach(line in lines){
if(sscanf(line,"%s - %s$br#%s:look %s",mc,name,exp,id)!=4) return;
html+=({mc+" - "+name+"("+id+")<br>经验："+exp+"<br>\n"});
}
sj = localtime(time());
text=
"<!DOCTYPE html>\n"
"<html>\n"
"<head>\n"
"<meta charset=\"utf-8\">\n"
"<title>"+LOCAL_MUD_NAME()+"MUD</title>\n"
"</head>\n"
"<body>\n"
"<div>\n"
"    <p>"+LOCAL_MUD_NAME()+"MUD BBS网页</p>\n"
"    <p>【经验排行榜】</p>\n"
"    <p>"+implode(html,"")+"</p>\n"
"    <p>目前在线巫师："+sizeof(SECURITY_D->query_wizlist())+"位<br>目前在线游戏玩家："+sizeof(users())+"人</p>\n"
"    <p>QQ群号：1074716854</p>\n"
"    <a href=\"https://jq.qq.com/?_wv=1027&k=wgLUypIH\">点击加群</a>\n"
"<br>\n"
"    <p>上次更新时间："+sj[5]+"年"+(sj[4]+1)+"月"+sj[3]+"号"+sj[2]+"时"+sj[1]+"分"+sj[0]+"秒。</p>\n"
"</div>\n"
"</body>\n"
"</html>\n"
;
"/cmds/usr/tops"->main(this_object(),"修为");
write_file("/cmds/usr/mudh.html",text+"\n",1);
cp("/cmds/usr/mudh.html","/www/mudh.html");
printf(text+"\n");
}
/*
BY：NAME
QQ：3468713544
DATE：2 0 2 2 . 0 2 . 0 3
*/
