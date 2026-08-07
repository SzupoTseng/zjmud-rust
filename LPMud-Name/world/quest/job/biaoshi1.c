#include <ansi.h>
inherit NPC;
void create()
{
        
        set_name("护镖镖师", ({ "biao shi"}));
        set("gender", "男性");
        set("age", random(10) + 25);
        set("str", 33);
        set("con", 26);
        set("int", 20);
        set("dex", 23);
        set("long", "福威镖局的镖师。\n");
        set("combat_exp", 10800000); 
        set("attitude", "friendly");
        set_skill("force", 150);
        set_skill("sword", 150);
        set_skill("dodge", 150);
        set_skill("parry", 150);
        set_skill("fanliangyi-dao", 150);
        set_skill("blade", 150);
	 set_skill("zixia-shengong",150);
        map_skill("blade","fanliangyi-dao");
        set("max_qi", 14500); 
        set("eff_jingli", 14000); 
        set("neili", 17000); 
        set("max_neili", 17000);
        set("jiali", 30);
                setup();
        carry_object("/clone/weapon/gangdao")->wield();
        carry_object("/clone/cloth/cloth")->wear();
}

void init()
{
        remove_call_out("leave");
        call_out("leave",600);
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
