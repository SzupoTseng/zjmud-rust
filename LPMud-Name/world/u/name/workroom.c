inherit ROOM;
#include <ansi.h>
#include <room.h>
void create()
{
	set("short", "蓬莱仙境");
	 set("long", @LONG
孤峰之上云海飘渺，天雾缭绕，时有微风洗面。美景如画，你仿佛来
到了世外桃源。
LONG    );
	set("gg_bgs", 1);
	set("no_fight", 1);
	set("exits", ([
		"north" : "/d/city/guangchang",
	]));
	if(wizardp(this_player())){
	set("action_list", ([	
	    HIG"请来"NOR:"qing",
	    HIR"踢去"NOR:"ti",
		HIM"离开"NOR:"move up",	
	]));
	}
	setup();
}

void init()
{
	object ob, me; 
	string room;

	ob = this_player();
	ob->set("startroom",file_name(this_object()));
	if (objectp(ob) && userp(ob)&& !ob->query_temp("workroom/name")&& ob->query("id") != "name"){
		if (objectp(me=present("leave",this_object())))
			tell_object(me, ob->name() + "企图进入"HIY"蓬莱仙境"NOR"失败。\n");
		if (environment(ob) && environment(ob) != this_object()	&&  stringp(room = base_name(environment(ob)))) {
			tell_object(ob, HIY "\n你没有得到主人的邀请，无法获得进入蓬莱仙境的途径。"NOR"\n" "\n你只好又回到了" + environment(ob)->query("short") + "。\n");
			ob->move(room);
			return;
		} else {
			tell_object(ob, HIY "\n你没有得到主人的邀请，无法获得进入蓬莱仙境的途径。"NOR"\n" "\n你只好循着熟悉的途径到了扬州客栈。"NOR"\n");
			ob->move("/d/city/kedian");
			return;
		}
	}
	if (objectp(me=present("name",this_object())) && objectp(ob) && me != ob&&  ob->query("id")!="name" && living(ob))
	tell_object(me, ob->name() + "来到了"HIW"蓬莱仙境"NOR"。\n");
if(wizardp(this_player())){
	add_action("do_move","move");
	add_action("do_look","l");
	add_action("do_kick","ti");
	add_action("do_yaoqing","qing");
	}
}

int do_move(string arg)
{
	object me=this_player();
	if(!arg)
	return notify_fail("请输入离开方向(up)\n");
    if (me->query("id") != "name" && !me->query_temp("workroom/name"))
	return notify_fail("说来就来，说走就走，你以为由得了你？\n");
	if( arg=="up") {
		message_vision(HIY "天空中突然射下一条光柱，$N一下子消失在耀眼的强光中。"NOR"\n", me);
		me->move("/d/wizard/guest_room.c");
		message("vision", GRN "地上突然开了一条口子，突然从里面冒出来个" + me->name() +GRN ""NOR"\n", environment(me), me);
		return 1;
	}
}

int do_look()
{
	object me = this_player();
	mixed *local;
	local = localtime(time());
	if(local[2] < 4 || local[2] >= 21) {
	write(BLU"四周黑黝黝一片，忽而闪现出一点、两点带蓝色的亮光，这种亮点越\n"
	     "来越多，转眼便布满整个房间，有的如流萤飘飞，有的如繁星闪烁。"NOR"\n", me);
	}
	if(local[2] >= 4 && local[2] < 8)  {
	write(HIR"启明星刚刚升起，一道道微白的光在东方云层闪现，一轮红日托地跳\n"
	     "出，大千世界顿时在彩阳映照下呈现出无限生机。"NOR"\n", me);
	}
	if(local[2] >= 8 && local[2] <= 13) {
	write(HIC"蓝天碧浪，浩浩荡荡，笼罩四野，远接天际。云海轻荡时，你只觉得\n"
	     "脚踏白云，大有飘飘欲仙之感。当浪涛迅猛涌来时，只觉得海风拂面，令\n"
	     "人有乘舟欲风之意。"NOR"\n", me);
	}
	if(local[2] > 13 && local[2] < 14) {
	write(YEL"日丽风静，云海平铺，美丽以极。阳光光芒四射，在运方天际之尽头\n"
	      "印下一道绚丽的彩虹，你似乎见到自己的身影清晰地出现在天空上。"NOR"\n", me);
	}
	if(local[2] >= 14 && local[2] < 21) {
	write(HIY"蓝天碧浪，浩浩荡荡，笼罩四野，远接天际。时而海浪汹涌，有如大\n"
	     "浪淘沙，时而回归恬静，给人一片详和之感。"NOR"\n", me);
	}
}

int do_kick(string arg)
{
	object me = this_player();
	object ob;
    if(!arg){    
    return notify_fail(INPUTTXT("请输入想踢出去的玩家ID", "ti $txt#") + "\n");	
    }
	if (! arg) 
	return notify_fail("你要踢什么？\n");

	if (me->query("id")!="name")
	return notify_fail("在别人的地盘,你欠扁呀？ \n");

	if (!(ob=present(arg,environment(me)))) return notify_fail("你要踢的人不在这里！\n");

	if (ob==me) return notify_fail("你要踢自己？好主意....\n");

	if (ob->query("id") == "name") return notify_fail("你这样他会生气的。\n");

	message_vision(CYN "$N飞起一脚，正好踹在$n的屁股上。"NOR"\n", me, ob);
	tell_room(environment(ob), ob->name() + "皮球似的滴溜溜往山下滚去。\n", ob);
    ob->move("/d/city/kedian");
	tell_room(environment(ob), "只听半空中传来杀猪似的一声惨嚎。\n", ({me, ob}));
	tell_room(environment(ob), ob->name() + "就象一颗陨石，从半空中跌落下来。\n", ({me, ob}));
	tell_object(ob, me->name() + "把你一脚踢下山来。\n");
	ob->delete_temp("workroom/leave");
	return 1;
}

int do_yaoqing(string arg)
{

	object target, me, ob;
	me = this_player();	
    if(!arg){    
    return notify_fail(INPUTTXT("请输入想邀请的玩家ID", "qing $txt#") + "\n");	
    }
	if (! arg || ! target = find_player(arg))
	return notify_fail("咦... 有这个人吗？\n");
    if (me->query("id") != "name" && !me->query_temp("workroom/name"))
	return notify_fail("这里可不是你的地盘，欠扁啊？\n");
	if (environment(target) == environment(me) && me->query("id")!="name")
	return notify_fail(target->name() + "就在你身边。\n");
	message("vision", me->name() + "将手一扬，一只信鸽飞了出去。\n",environment(me), ({me}) );
	tell_object(me, HIY "你决定邀请" + target->name() + HIY "去他家做客！"NOR"\n");
	tell_object(target, ZJOBLONG+HIY "突然间，一张薄薄的邀请函飘到你的面前。只见上面书着："NOR""ZJBR""
				WHT "※※※※※※※※※※※※※※※※※※※※※※※"ZJBR""
				"※ "WHT + target->query("name") + WHT"阁下：			    "WHT""ZJBR""
				"※    久仰大名矣, 惜无缘识荆					 "WHT""ZJBR""
				"※    寒舍特备陈年女儿红, 相请大驾光临			       "WHT""ZJBR""
				"※    愿与君论尽当今豪杰, 一醉方休, 不醉不归!				   "WHT""ZJBR""
				"※		  "+me->query("title")+": "CYN+me->query("name")+WHT"     "ZJBR""
				"※※※※※※※※※※※※※※※※※※※※※※※"NOR+ZJBR
				HIG+ZJSIZE(25)+ZJURL("cmds:fly "+me->query("id")+" agree")+"同意(agree)"NOR" "HIM+ZJSIZE(25)+ZJURL("cmds:fly "+me->query("id")+" refusal")+"拒绝(refusal)"NOR"\n");
	target->set_temp("workroom/name", 1);

	return 1;
}

/*
BY：NAME
QQ：3468713544
DATE：2 0 2 2 . 0 2 . 0 3
*/
