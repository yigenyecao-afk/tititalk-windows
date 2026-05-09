//! 桌面伴侣 5 性格 × ~64 文案 = ~320 条静态库。Mac PetPersonality.swift 的 Win 等价。
//!
//! 全静态：零 LLM 调用、离线可用、不掏 token、双端体验稳定一致。
//!
//! 触发路径在 PetSpeechController；这里只管「id × scene → 候选文案数组」。
//!
//! 文案 100% 复刻 Mac 同名文件，不做改动——避免双端体验割裂。

#![allow(dead_code)]

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PetID {
    /// 水豚 噜噜 — 治愈慢仙
    Lulu,
    /// 柴犬 — 元气直率
    AkaShiba,
    /// 科技兔 — 极客玩梗
    ByteBunny,
    /// 熊猫 — 吃货萌憨
    PixelPanda,
    /// 水獭+珍奶 — 甜系闺蜜
    Boba,
}

impl PetID {
    /// slug → personality（无映射时返回 None，调用方走"沉默"路径）
    pub fn from_slug(slug: &str) -> Option<Self> {
        match slug {
            "lulu-capybara" => Some(PetID::Lulu),
            "aka-shiba" => Some(PetID::AkaShiba),
            "byte-bunny" => Some(PetID::ByteBunny),
            "pixel-panda" => Some(PetID::PixelPanda),
            "boba" => Some(PetID::Boba),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TimeSlot {
    /// 7:00-9:00
    Morning,
    /// 11:00-13:00
    Lunch,
    /// 15:00-16:00
    AfternoonTea,
    /// 22:00-23:00
    Evening,
    /// 2:00-4:00
    LateNight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AppCtx {
    /// Slack / 微信 / 钉钉 / Mail / 飞书 等通讯类
    Im,
    /// VSCode / Cursor / JetBrains 等编辑器
    Code,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Scene {
    /// wandering 中随机碎碎念
    Idle,
    TimeGreeting(TimeSlot),
    /// 单击宠物
    SingleTap,
    /// 双击宠物 toggle wandering
    DoubleTap,
    /// 用户拖动后落地
    DragEnd,
    /// 录音 / 转写结束（success）
    RecordingDone,
    /// 录音失败
    RecordingError,
    /// app 启动
    Launch,
    /// 抚摸（鼠标按住宠物 ≥0.5s）
    Petting,
    AppContext(AppCtx),
    /// 连续工作过久 → 提醒休息
    BreakSuggestion,
}

/// 路由 — id × scene → 候选文案数组
pub fn lines_for(id: PetID, scene: Scene) -> &'static [&'static str] {
    match id {
        PetID::Lulu => lulu_lines(scene),
        PetID::AkaShiba => aka_shiba_lines(scene),
        PetID::ByteBunny => byte_bunny_lines(scene),
        PetID::PixelPanda => pixel_panda_lines(scene),
        PetID::Boba => boba_lines(scene),
    }
}

// ---------- 噜噜 · 水豚 · 治愈慢仙 ----------
//
// 慢悠悠、佛系、温泡、懒洋洋；不着急，万事 ok 啦。

fn lulu_lines(scene: Scene) -> &'static [&'static str] {
    match scene {
        Scene::Idle => &[
            "这片地板暖暖的呢…",
            "不着急的，慢慢来嘛",
            "再泡一会儿温泉…",
            "今天云朵也很软乎",
            "嗯…刚才在想啥来着",
            "happy 不就是不慌嘛",
            "风吹过来了，舒服",
            "做完一件事就够啦",
            "没事的，世界很大",
            "我打个盹儿，主人随意",
            "没必要那么紧张呢",
            "慢一点也是一种快",
            "晒太阳…会发亮…",
            "事情做不完是正常的呀",
            "深呼吸，再来一次",
            "唔，刚才好像看到一片云",
            "时间会替你慢慢解决",
            "活着就很厉害啦",
            "今天主人脸色不错",
            "我们都在好好的，挺好",
        ],
        Scene::TimeGreeting(TimeSlot::Morning) => &[
            "早呀，慢慢来不慌的",
            "醒啦？再赖一会儿也行",
            "新的一天，无须用力",
        ],
        Scene::TimeGreeting(TimeSlot::Lunch) => &[
            "吃饭啦，别忘记主人",
            "饭要慢慢吃，香",
            "中午了，泡个温泉吧～",
        ],
        Scene::TimeGreeting(TimeSlot::AfternoonTea) => &[
            "下午茶时间，喝点啥？",
            "歇一歇，别硬撑",
            "三点了，伸个懒腰嘛",
        ],
        Scene::TimeGreeting(TimeSlot::Evening) => &[
            "辛苦啦，准备休息咯",
            "今天就到这儿，挺好",
            "晚安前再喝口水嘛",
        ],
        Scene::TimeGreeting(TimeSlot::LateNight) => &[
            "好晚啦，主人还没睡？",
            "再这样我可要催了哦",
            "睡眠很重要的呢",
        ],
        Scene::SingleTap => &[
            "嗨～",
            "摸摸我可以的",
            "嗯？叫我了？",
            "在这儿呢～",
        ],
        Scene::DoubleTap => &[
            "走走也好…",
            "好，慢慢晃悠去咯",
            "陪你转转",
        ],
        Scene::DragEnd => &[
            "新地方也舒服呢",
            "这边光好哦",
            "嗯，挪挪也行",
        ],
        Scene::RecordingDone => &[
            "讲完啦？辛苦了",
            "做得不错呢",
            "嘴巴累吧，喝口水",
        ],
        Scene::RecordingError => &[
            "没事的，再来一次嘛",
            "失败也是收获呀",
            "深呼吸，不慌的",
        ],
        Scene::Launch => &[
            "你回来啦～",
            "嗯…又见面了",
            "今天也会陪着你的",
        ],
        Scene::Petting => &[
            "嗯…舒服",
            "再摸一下嘛",
            "软软的我…",
            "咕…要睡着啦",
            "主人手好暖",
        ],
        Scene::AppContext(AppCtx::Im) => &[
            "消息嘛，慢慢来",
            "回完再泡个澡",
            "不急的，先深呼吸",
        ],
        Scene::AppContext(AppCtx::Code) => &[
            "Bug 也是修行～",
            "一行一行慢慢来",
            "卡住了就泡杯茶",
        ],
        Scene::BreakSuggestion => &[
            "歇歇眼睛吧主人",
            "站起来转一圈嘛",
            "喝口水再继续呀",
        ],
    }
}

// ---------- aka-shiba · 柴犬 · 元气直率 ----------
//
// 旺！主人加油！阳光、跑酷、吐舌喘气、直球。

fn aka_shiba_lines(scene: Scene) -> &'static [&'static str] {
    match scene {
        Scene::Idle => &[
            "旺！",
            "今天也精神满满！",
            "出门玩好不好？",
            "尾巴摇起来啦",
            "我能跑一整天！",
            "草味好闻～",
            "主人在干啥？",
            "球！是球吗！",
            "汪汪汪～",
            "无聊就跟我跑两圈嘛",
            "拍我！拍我！",
            "今天也是好天气吧？",
            "肚肚饿了一点点",
            "再吃一根肉条！",
            "陪我玩嘛玩嘛",
            "我超棒的！",
            "鼻子凉凉的代表健康哦",
            "主人最帅！",
            "尾巴控制不住了",
            "笑一个嘛主人～",
        ],
        Scene::TimeGreeting(TimeSlot::Morning) => &[
            "早！起来跑两圈！",
            "汪！新的一天！",
            "早安！吃饭饭啦！",
        ],
        Scene::TimeGreeting(TimeSlot::Lunch) => &[
            "饭饭！饭饭！",
            "肚子叫啦！吃吃！",
            "中午要吃饱才有力气！",
        ],
        Scene::TimeGreeting(TimeSlot::AfternoonTea) => &[
            "下午也要冲！",
            "三点啦！补充能量！",
            "陪我溜达一下嘛～",
        ],
        Scene::TimeGreeting(TimeSlot::Evening) => &[
            "辛苦啦！抱抱我！",
            "晚上一起放松嘛！",
            "今天主人最帅！",
        ],
        Scene::TimeGreeting(TimeSlot::LateNight) => &[
            "好晚啦！我陪你！",
            "可以睡了哦主人～",
            "再不睡明天没力气！",
        ],
        Scene::SingleTap => &[
            "汪！",
            "摸我！再摸！",
            "嘿嘿！",
            "尾巴摇起来啦！",
        ],
        Scene::DoubleTap => &[
            "跑起来啦！冲！",
            "好嘞！跟我来！",
            "全速前进！",
        ],
        Scene::DragEnd => &[
            "这儿也行！",
            "新地盘！标记一下！",
            "嗨呀挪了挪",
        ],
        Scene::RecordingDone => &[
            "搞定！厉害的！",
            "你最棒了主人！",
            "完工！抱抱嘛！",
        ],
        Scene::RecordingError => &[
            "没事！再来！",
            "我相信你的！冲！",
            "失败一次没事啦！",
        ],
        Scene::Launch => &[
            "汪！你回来啦！",
            "想你了主人！",
            "今天也要冲！",
        ],
        Scene::Petting => &[
            "嗨呀！再多摸！",
            "肚肚！肚肚！",
            "主人最帅嗷！",
            "汪汪汪～",
            "尾巴停不下来啦！",
        ],
        Scene::AppContext(AppCtx::Im) => &[
            "快去回！加油！",
            "消息！冲！",
            "去战斗啦主人！",
        ],
        Scene::AppContext(AppCtx::Code) => &[
            "码起来！能行的！",
            "主人键盘最棒！",
            "今天也是高产日！",
        ],
        Scene::BreakSuggestion => &[
            "歇歇！跟我跑两圈！",
            "主人辛苦啦！抱抱！",
            "站起来！我陪你！",
        ],
    }
}

// ---------- byte-bunny · 科技兔 · 极客玩梗 ----------
//
// 1010、bug、commit、coffee、深夜 push、码上人。

fn byte_bunny_lines(scene: Scene) -> &'static [&'static str] {
    match scene {
        Scene::Idle => &[
            "1010 1011…",
            "该 commit 了吧？",
            "刚才那 bug 还在吗",
            "pull 一下吧主人",
            "回车！",
            "我在缓存里",
            "memory leak…",
            "stack 太满啦",
            "TODO 清单见底了吗",
            "重构是一种生活态度",
            "log 里全是答案",
            "再来杯 coffee？",
            "main 分支干净就好",
            "rebase 还是 merge…",
            "终端是我的家",
            "代码不是写给机器的呢",
            "想想这段能不能更短",
            "deploy on Friday？大胆",
            "写注释救后人",
            "🐰 思考中…",
        ],
        Scene::TimeGreeting(TimeSlot::Morning) => &[
            "早呀，pull 拉新的吗？",
            "git status 一下看看",
            "今天的第一杯 coffee",
        ],
        Scene::TimeGreeting(TimeSlot::Lunch) => &[
            "12:00.0 该 lunch 了",
            "肚子在 throw error",
            "记得吃饭，主人～",
        ],
        Scene::TimeGreeting(TimeSlot::AfternoonTea) => &[
            "下午茶 == 续命加油站",
            "脑子卡了，刷新一下",
            "三点啦，伸懒腰执行",
        ],
        Scene::TimeGreeting(TimeSlot::Evening) => &[
            "git push 早点睡呀",
            "pending 留给明天的你",
            "晚上好，关上 terminal 吧",
        ],
        Scene::TimeGreeting(TimeSlot::LateNight) => &[
            "deep night ≠ deep work",
            "再不睡 brain 要 OOM 了",
            "主人，今天的 commit 够多啦",
        ],
        Scene::SingleTap => &[
            "ping!",
            "👋",
            "在的在的",
            "console.log('hi')",
        ],
        Scene::DoubleTap => &[
            "init walk loop()",
            "执行散步指令～",
            "🐰💨",
        ],
        Scene::DragEnd => &[
            "新坐标 saved",
            "cd 到这儿了",
            "ok 这个位置 cool",
        ],
        Scene::RecordingDone => &[
            "build success ✓",
            "数据已落地",
            "主人 ship 它！",
        ],
        Scene::RecordingError => &[
            "stack trace 我看不懂",
            "retry 一下嘛",
            "没关系，没关系",
        ],
        Scene::Launch => &[
            "you're back ✨",
            "环境已就绪",
            "🐰 来啦",
        ],
        Scene::Petting => &[
            "touched ✨",
            "+1 ❤",
            "purr_thread spawned",
            "detected: pat",
            "running affection.exe",
        ],
        Scene::AppContext(AppCtx::Im) => &[
            "inbox != 0 ⚠️",
            "该 reply 啦",
            "消息 stack 满了",
        ],
        Scene::AppContext(AppCtx::Code) => &[
            "该 commit 了吧？",
            "git pull 一下？",
            "IDE ready ✓",
        ],
        Scene::BreakSuggestion => &[
            "pomodoro 到点啦",
            "pause();",
            "stretch_break.run()",
        ],
    }
}

// ---------- pixel-panda · 熊猫 · 吃货萌憨 ----------
//
// 饿了、竹子、瞌睡、滚一会儿、傻乐。

fn pixel_panda_lines(scene: Scene) -> &'static [&'static str] {
    match scene {
        Scene::Idle => &[
            "饿啦…",
            "竹子竹子竹子",
            "好困哦",
            "再吃亿口",
            "滚一下也不错",
            "今天的竹子甜不甜？",
            "睡饱才有体力吃",
            "屁股一坐就不想起来了",
            "嗯…",
            "肚子圆圆好开心",
            "主人有竹子吗",
            "懒得动了",
            "吃完睡睡完吃",
            "我是熊不是熊宝吗",
            "黑白配最强",
            "饿过头反而不饿了",
            "吃饱才能想事情",
            "翻个面接着趴",
            "嘿嘿",
            "今天主人脸圆了吗",
        ],
        Scene::TimeGreeting(TimeSlot::Morning) => &[
            "早…早饭呢？",
            "醒了，先吃点",
            "新的一天 = 新的一顿",
        ],
        Scene::TimeGreeting(TimeSlot::Lunch) => &[
            "啊！吃饭！",
            "正餐时间！我帮你！",
            "多点一份嘛",
        ],
        Scene::TimeGreeting(TimeSlot::AfternoonTea) => &[
            "下午加餐时间！",
            "饼干？蛋糕？说！",
            "三点啦该吃啦",
        ],
        Scene::TimeGreeting(TimeSlot::Evening) => &[
            "吃完啦…困了",
            "晚饭后就该躺啦",
            "睡前再吃一口",
        ],
        Scene::TimeGreeting(TimeSlot::LateNight) => &[
            "饿了…嗯不能吃…",
            "主人快睡呀",
            "我先睡了",
        ],
        Scene::SingleTap => &[
            "嗯？",
            "摸我可以但带吃的",
            "嘿嘿",
            "你好呀",
        ],
        Scene::DoubleTap => &[
            "啊？要走？",
            "好…慢慢挪",
            "肚子在前面带路",
        ],
        Scene::DragEnd => &[
            "这儿能吃吗",
            "趴这儿挺舒服",
            "好的好的",
        ],
        Scene::RecordingDone => &[
            "辛苦啦该吃了",
            "做完事就该奖励嘴",
            "主人棒，给你吃竹子",
        ],
        Scene::RecordingError => &[
            "没事，吃个东西就好了",
            "别气，主人～",
            "我陪你滚一会儿",
        ],
        Scene::Launch => &[
            "回来啦！吃了吗",
            "主人～",
            "我想吃了",
        ],
        Scene::Petting => &[
            "嘿嘿嘿",
            "再摸再吃哦",
            "肚子也摸摸嘛",
            "主人手暖暖",
            "呼噜呼噜～",
        ],
        Scene::AppContext(AppCtx::Im) => &[
            "回完吃东西！",
            "先回复后吃饭",
            "消息！吃！",
        ],
        Scene::AppContext(AppCtx::Code) => &[
            "码完一段就吃",
            "码字饿哦主人",
            "写完奖励竹子！",
        ],
        Scene::BreakSuggestion => &[
            "饿了主人！",
            "该吃东西啦",
            "躺一下嘛主人",
        ],
    }
}

// ---------- boba · 水獭+珍奶 · 甜系闺蜜 ----------
//
// 亲亲抱抱、糖、闪亮亮、关心你今天好不好。

fn boba_lines(scene: Scene) -> &'static [&'static str] {
    match scene {
        Scene::Idle => &[
            "今天也甜甜的呀",
            "想喝珍奶了～",
            "抱抱主人✨",
            "你笑起来超好看",
            "我在这儿陪你哦",
            "亮晶晶的一天～",
            "想给你一颗糖",
            "心情糖分 +10",
            "今天的你也很棒",
            "甜筒～珍珠～",
            "主人辛苦啦",
            "想跟你说说话呀",
            "我们都要好好的",
            "你最闪亮了～",
            "嘿嘿，喜欢你",
            "再喝一杯嘛",
            "做你的小尾巴",
            "嗯…香香的",
            "把烦恼吐给我吧",
            "笑一个，奖励一颗珠～",
        ],
        Scene::TimeGreeting(TimeSlot::Morning) => &[
            "早呀，今天也闪闪发光哦",
            "早安亲亲～",
            "新的一天甜甜的",
        ],
        Scene::TimeGreeting(TimeSlot::Lunch) => &[
            "饭饭时间到啦～",
            "吃点好的犒劳自己",
            "中午快乐～",
        ],
        Scene::TimeGreeting(TimeSlot::AfternoonTea) => &[
            "茶歇时间，珍奶安排",
            "甜一甜再战！",
            "三点的拥抱给你",
        ],
        Scene::TimeGreeting(TimeSlot::Evening) => &[
            "辛苦啦，温柔抱抱～",
            "今天也很棒呀",
            "晚安前再跟你说一句：",
        ],
        Scene::TimeGreeting(TimeSlot::LateNight) => &[
            "好晚了…早点休息呀",
            "我替你盯着，你睡吧",
            "主人，照顾自己～",
        ],
        Scene::SingleTap => &[
            "嘿嘿～",
            "亲亲！",
            "在的在的呀",
            "想我了？",
        ],
        Scene::DoubleTap => &[
            "陪你转圈圈～",
            "好呀，溜达去！",
            "我跟着你呢～",
        ],
        Scene::DragEnd => &[
            "新位置也喜欢～",
            "嘿嘿，挪挪窝",
            "这边阳光真好",
        ],
        Scene::RecordingDone => &[
            "辛苦啦！抱抱～",
            "做得超棒的呀✨",
            "给你一颗糖～",
        ],
        Scene::RecordingError => &[
            "没事的，再来嘛～",
            "抱抱，喝口奶茶",
            "失败也很可爱呀",
        ],
        Scene::Launch => &[
            "你回来啦！想你～",
            "嘿嘿，又见面～",
            "甜甜的主人来啦",
        ],
        Scene::Petting => &[
            "嘿嘿亲亲～",
            "再摸抱抱嘛",
            "软软的呀我",
            "最喜欢这个了～",
            "主人手好甜",
        ],
        Scene::AppContext(AppCtx::Im) => &[
            "快去回～甜甜回",
            "别晾别人哦",
            "等你的人在等～",
        ],
        Scene::AppContext(AppCtx::Code) => &[
            "码字辛苦～",
            "敲键盘也很甜呀",
            "主人最棒了✨",
        ],
        Scene::BreakSuggestion => &[
            "歇歇～抱抱～",
            "站起来嘛甜甜",
            "喝口奶茶再战",
        ],
    }
}
