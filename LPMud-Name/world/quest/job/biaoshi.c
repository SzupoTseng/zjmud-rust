#include <ansi.h>
inherit NPC;

int do_copy(object me);
//int do_back(object me);

void create()
{
      string weapon;
        set_name("护镖镖师", ({ "biaoshi"}));
        set("gender", "男性");
        set("age", random(10) + 25);
        set("no_quest", 1);
        set("str", 33);
        set("con", 26);
        set("int", 20);
        set("dex", 23);
        set("long", "长风镖局的镖师。\n");
        set("combat_exp", 20800000 + random(4000000));
        set("attitude", "friendly");
        set_skill("force", 50+random(300));
        set_skill("cuff", 50+random(300));
        set_skill("dodge", 50+random(300));
        set_skill("parry", 50+random(300));
		set_skill("lingxu-bu", 50+random(300));
        set_skill("taiji-quan", 50+random(300));
		set_skill("zixia-shengong",50+random(300));
        map_skill("cuff","taiji-quan");
        map_skill("parry","taiji-quan");
        map_skill("force","zixia-shengong");
        set("max_qi", 5000);
		set("qi", 6000);
        set("eff_jingli", 1400);
        set("neili", 1700);
        set("max_neili", 1700);
        set("jiali", 30);

        setup();

        carry_object("/clone/misc/cloth")->wear();
}

int checking(object ob, object me)
{
        if(!me || !present(me, environment())) {
                remove_call_out("checking");
                call_out("checking", 0, ob);
        } else
        call_out("checking", 2, ob, me);
        return 1;
}

int do_copy(object me)
{
        int i;
        object ob;
        ob = this_object();

		if(!me->query_temp("xx_rob")){
      	//   do_back(me);
      	                   call_out("checking", 5, ob);
      	   return 0;
      	   }
        message_vision(HIR"突然从车队后窜出一个$N，二话不说就扑向了$n！\n"NOR, ob, me);
        me->add_temp("biaoshi", 1+random(5));

        ob->kill_ob(me);
		me->kill_ob(ob);
        checking(ob, me);

        call_out("leave", 350,  ob);
        return 1;
}

void init()
{
        remove_call_out("leave");
        call_out("leave",500);
}

void leave()
{
        object ob = this_object();
        if (!ob->is_fighting()) {
                message_vision(this_object()->query("name") + "钻进路边的杂草，不见了。\n" NOR,this_object());
                destruct(this_object());
                }
        else call_out("leave",30);
}
/*
BY：NAME
QQ：3468713544
DATE：2 0 2 2 . 0 2 . 0 3
*/
