// f_condi.c

#include <ansi.h>

int update_condition(object me, int duration)
{
	me->apply_condition("f_condi", duration - 1);
	if( duration < 1 ) return 0;
	return 1;
}

/*
BY：NAME
QQ：3468713544
DATE：2 0 2 2 . 0 2 . 0 3
*/
