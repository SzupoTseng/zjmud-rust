
#include <ansi.h>

inherit COMBINED_ITEM;

string query_autoload() { return query_amount() + ""; }

void autoload(string param)
{
	int amt;

	if (sscanf(param, "%d", amt) == 1)
		set_amount(amt);
}

void setup()
{
	set_amount(1);
	::setup();
}

void create()
{
	set_name(HIR"师门重置卡" NOR, ({ "shimen cz"}) );
	if (clonep())
		set_default_object(__FILE__);
	else {
		set("long", "使用后可以清零本周师门次数。。。\n");
		set("unit", "张");
		set("base_unit", "张");
		set("base_weight", 10);
		set("base_value", 10000);
		set("yuanbao", 100);
            	set("no_sell", 1);
        set("no_drop",1);
        set("no_give",1);
		set("only_do_effect", 1);
	}
	setup();
}

int do_effect(object me)
{
    me->set("shimen/today",0);	
	write(HIY"本周师门已重置！！！"NOR"\n");
    add_amount(-1);
     return 1;
}




/*
BY：NAME
QQ：3468713544
DATE：2 0 2 2 . 0 2 . 0 3
*/
