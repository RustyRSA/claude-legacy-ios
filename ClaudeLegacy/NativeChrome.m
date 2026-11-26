//
//  NativeChrome.m
//  ClaudeLegacy
//
//

#import "NativeChrome.h"
#import "AppShared.h"

static UIImage *SymbolImage(NSString *name, CGFloat pointSize, UIImageSymbolWeight weight) {
    UIImageSymbolConfiguration *config = [UIImageSymbolConfiguration configurationWithPointSize:pointSize
                                                                                         weight:weight];
    return [UIImage systemImageNamed:name withConfiguration:config];
}

@implementation NativeChrome {
    UIView *_topBar;
    UIView *_bottomBar;
    UILabel *_titleLabel;
    UIButton *_listButton;
    UIButton *_incognitoButton;
    UIButton *_newChatButton;
    UIButton *_moreButton;
    UIView *_field;
    UITextView *_textView;
    UILabel *_placeholder;
    NSLayoutConstraint *_textHeight;
    UIButton *_plusButton;
    UIButton *_modelButton;
    UIButton *_micButton;
    UIButton *_actionButton;
    UIButton *_attachButton;
    NSString *_actionName;
    NSLayoutConstraint *_topBarBottom;
    NSArray<UIButton *> *_buttons;
    BOOL _composerShown;
    CGFloat _reportedInset;
    UIView *_curtain;
    UIActivityIndicatorView *_spinner;
    NSUInteger _coverToken;
    BOOL _shown;
    BOOL _waiting;
    NSUInteger _waitToken;
    BOOL _streaming;
    BOOL _voice;
    BOOL _dictating;
    BOOL _refocusAfterSend;
}

- (instancetype)initWithFrame:(CGRect)frame {
    self = [super initWithFrame:frame];
    if (self) {
        self.translatesAutoresizingMaskIntoConstraints = NO;
        self.hidden = YES;
        self.alpha = 0;
        [self buildControls];
    }
    return self;
}

- (UIView *)hitTest:(CGPoint)point withEvent:(UIEvent *)event {
    UIView *hit = [super hitTest:point withEvent:event];
    return hit == self ? nil : hit;
}

- (UIButton *)barButton:(NSString *)symbol action:(SEL)action label:(NSString *)label {
    UIButton *button = [UIButton buttonWithType:UIButtonTypeSystem];
    button.translatesAutoresizingMaskIntoConstraints = NO;
    [button setImage:SymbolImage(symbol, 19, UIImageSymbolWeightRegular) forState:UIControlStateNormal];
    button.accessibilityLabel = label;
    [button addTarget:self action:action forControlEvents:UIControlEventTouchUpInside];
    [NSLayoutConstraint activateConstraints:@[
        [button.widthAnchor constraintEqualToConstant:44],
        [button.heightAnchor constraintEqualToConstant:44],
    ]];
    return button;
}

/// A solid bar with a hairline along the edge that faces the page.
- (UIView *)barWithLineAtTop:(BOOL)lineAtTop {
    UIView *bar = [[UIView alloc] init];
    bar.translatesAutoresizingMaskIntoConstraints = NO;
    bar.backgroundColor = AppBackgroundColor();
    UIView *line = [[UIView alloc] init];
    line.translatesAutoresizingMaskIntoConstraints = NO;
    line.backgroundColor = UIColor.separatorColor;
    [bar addSubview:line];
    [NSLayoutConstraint activateConstraints:@[
        [line.leadingAnchor constraintEqualToAnchor:bar.leadingAnchor],
        [line.trailingAnchor constraintEqualToAnchor:bar.trailingAnchor],
        [line.heightAnchor constraintEqualToConstant:1.0 / MAX(UIScreen.mainScreen.scale, 1.0)],
        lineAtTop ? [line.topAnchor constraintEqualToAnchor:bar.topAnchor]
                  : [line.bottomAnchor constraintEqualToAnchor:bar.bottomAnchor],
    ]];
    [self addSubview:bar];
    return bar;
}

- (void)buildControls {
    UILayoutGuide *safe = self.safeAreaLayoutGuide;

    // The top bar.
    _topBar = [self barWithLineAtTop:NO];
    _listButton = [self barButton:@"sidebar.left" action:@selector(menuTapped) label:@"Chats"];
    _incognitoButton = [self barButton:@"eye.slash" action:@selector(incognitoTapped) label:@"Incognito chat"];
    _newChatButton = [self barButton:@"square.and.pencil" action:@selector(newChatTapped) label:@"New chat"];
    _moreButton = [self barButton:@"ellipsis.circle" action:@selector(moreTapped) label:@"Chat options"];

    UIStackView *rightButtons = [[UIStackView alloc] initWithArrangedSubviews:@[_incognitoButton, _newChatButton, _moreButton]];
    rightButtons.translatesAutoresizingMaskIntoConstraints = NO;
    rightButtons.axis = UILayoutConstraintAxisHorizontal;

    _titleLabel = [[UILabel alloc] init];
    _titleLabel.translatesAutoresizingMaskIntoConstraints = NO;
    _titleLabel.font = [UIFont systemFontOfSize:17 weight:UIFontWeightSemibold];
    _titleLabel.textColor = UIColor.labelColor;
    _titleLabel.textAlignment = NSTextAlignmentCenter;
    _titleLabel.lineBreakMode = NSLineBreakByTruncatingTail;
    _titleLabel.text = @"New chat";
    [_titleLabel setContentCompressionResistancePriority:UILayoutPriorityDefaultLow forAxis:UILayoutConstraintAxisHorizontal];

    for (UIView *view in @[_listButton, rightButtons, _titleLabel]) {
        [_topBar addSubview:view];
    }
    CGFloat savedHeight = [NSUserDefaults.standardUserDefaults doubleForKey:kChromeTopHeightKey];
    _topBarBottom = [_topBar.bottomAnchor constraintEqualToAnchor:safe.topAnchor
                                                         constant:MIN(MAX(savedHeight, 44), 72)];
    [NSLayoutConstraint activateConstraints:@[
        [_topBar.topAnchor constraintEqualToAnchor:self.topAnchor],
        [_topBar.leadingAnchor constraintEqualToAnchor:self.leadingAnchor],
        [_topBar.trailingAnchor constraintEqualToAnchor:self.trailingAnchor],
        _topBarBottom,
        [_listButton.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor constant:4],
        [_listButton.bottomAnchor constraintEqualToAnchor:_topBar.bottomAnchor],
        [rightButtons.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor constant:-4],
        [rightButtons.bottomAnchor constraintEqualToAnchor:_topBar.bottomAnchor],
        [_titleLabel.centerXAnchor constraintEqualToAnchor:_topBar.centerXAnchor],
        [_titleLabel.centerYAnchor constraintEqualToAnchor:_listButton.centerYAnchor],
        [_titleLabel.leadingAnchor constraintGreaterThanOrEqualToAnchor:_listButton.trailingAnchor constant:4],
        [_titleLabel.trailingAnchor constraintLessThanOrEqualToAnchor:rightButtons.leadingAnchor constant:-4],
    ]];

    // The message bar.
    _bottomBar = [self barWithLineAtTop:YES];

    UIButtonConfiguration *modelConfig = [UIButtonConfiguration plainButtonConfiguration];
    modelConfig.contentInsets = NSDirectionalEdgeInsetsMake(0, 8, 0, 8);
    modelConfig.image = SymbolImage(@"chevron.down", 10, UIImageSymbolWeightSemibold);
    modelConfig.imagePlacement = NSDirectionalRectEdgeTrailing;
    modelConfig.imagePadding = 4;
    modelConfig.baseForegroundColor = UIColor.secondaryLabelColor;
    _modelButton = [UIButton buttonWithConfiguration:modelConfig primaryAction:nil];
    _modelButton.translatesAutoresizingMaskIntoConstraints = NO;
    _modelButton.accessibilityLabel = @"Model";
    [_modelButton addTarget:self action:@selector(modelTapped) forControlEvents:UIControlEventTouchUpInside];
    // A native menu, filled from claude.ai's model menu each time it opens.
    __weak typeof(self) weakSelf = self;
    UIDeferredMenuElement *models = [UIDeferredMenuElement elementWithUncachedProvider:^(void (^completion)(NSArray<UIMenuElement *> *)) {
        typeof(self) strongSelf = weakSelf;
        if (strongSelf == nil) {
            completion(@[]);
            return;
        }
        [strongSelf menuElementsFor:@"model" completion:completion];
    }];
    _modelButton.menu = [UIMenu menuWithChildren:@[models]];
    _modelButton.showsMenuAsPrimaryAction = YES;
    [self setModel:@"" effort:@""];

    _plusButton = [self barButton:@"plus" action:@selector(plusTapped) label:@"Add files"];
    // The + menu is native too, filled from claude.ai's + menu each time it opens
    // (files and photos, connectors, research, web search, …).
    UIDeferredMenuElement *extras = [UIDeferredMenuElement elementWithUncachedProvider:^(void (^completion)(NSArray<UIMenuElement *> *)) {
        typeof(self) strongSelf = weakSelf;
        if (strongSelf == nil) {
            completion(@[]);
            return;
        }
        [strongSelf menuElementsFor:@"plus" completion:completion];
    }];
    _plusButton.menu = [UIMenu menuWithChildren:@[extras]];
    _plusButton.showsMenuAsPrimaryAction = YES;

    _field = [[UIView alloc] init];
    _field.translatesAutoresizingMaskIntoConstraints = NO;
    _field.backgroundColor = UIColor.tertiarySystemFillColor;
    _field.layer.cornerRadius = 18;

    _textView = [[UITextView alloc] init];
    _textView.translatesAutoresizingMaskIntoConstraints = NO;
    _textView.font = [UIFont systemFontOfSize:17];
    _textView.textColor = UIColor.labelColor;
    _textView.backgroundColor = UIColor.clearColor;
    _textView.textContainerInset = UIEdgeInsetsMake(8, 0, 8, 0);
    _textView.scrollEnabled = NO;
    _textView.delegate = self;

    _placeholder = [[UILabel alloc] init];
    _placeholder.translatesAutoresizingMaskIntoConstraints = NO;
    _placeholder.font = [UIFont systemFontOfSize:17];
    _placeholder.textColor = UIColor.placeholderTextColor;
    _placeholder.text = @"Message";
    _placeholder.userInteractionEnabled = NO;

    _micButton = [self barButton:@"mic" action:@selector(micTapped) label:@"Dictate"];
    _micButton.tintColor = UIColor.secondaryLabelColor;

    _actionButton = [UIButton buttonWithType:UIButtonTypeSystem];
    _actionButton.translatesAutoresizingMaskIntoConstraints = NO;
    _actionButton.layer.cornerRadius = 16;
    [_actionButton addTarget:self action:@selector(actionTapped) forControlEvents:UIControlEventTouchUpInside];

    for (UIView *view in @[_textView, _placeholder, _micButton]) {
        [_field addSubview:view];
    }
    // Files attached in claude.ai's (hidden) box: a paperclip with their number at
    // the right of the model row; its menu lists them, each can be removed.
    UIButtonConfiguration *attachConfig = [UIButtonConfiguration plainButtonConfiguration];
    attachConfig.image = SymbolImage(@"paperclip", 13, UIImageSymbolWeightSemibold);
    attachConfig.imagePadding = 4;
    attachConfig.contentInsets = NSDirectionalEdgeInsetsMake(0, 8, 0, 8);
    attachConfig.baseForegroundColor = UIColor.secondaryLabelColor;
    _attachButton = [UIButton buttonWithConfiguration:attachConfig primaryAction:nil];
    _attachButton.translatesAutoresizingMaskIntoConstraints = NO;
    _attachButton.showsMenuAsPrimaryAction = YES;
    _attachButton.hidden = YES;

    for (UIView *view in @[_modelButton, _plusButton, _field, _actionButton, _attachButton]) {
        [_bottomBar addSubview:view];
    }

    _textHeight = [_textView.heightAnchor constraintEqualToConstant:36];
    [NSLayoutConstraint activateConstraints:@[
        [_bottomBar.leadingAnchor constraintEqualToAnchor:self.leadingAnchor],
        [_bottomBar.trailingAnchor constraintEqualToAnchor:self.trailingAnchor],
        [_bottomBar.bottomAnchor constraintEqualToAnchor:self.bottomAnchor],
        [_bottomBar.topAnchor constraintEqualToAnchor:_modelButton.topAnchor constant:-4],

        [_modelButton.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor constant:8],
        [_modelButton.heightAnchor constraintEqualToConstant:30],
        [_modelButton.trailingAnchor constraintLessThanOrEqualToAnchor:_attachButton.leadingAnchor constant:-4],
        [_attachButton.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor constant:-8],
        [_attachButton.centerYAnchor constraintEqualToAnchor:_modelButton.centerYAnchor],
        [_attachButton.heightAnchor constraintEqualToConstant:30],
        [_modelButton.bottomAnchor constraintEqualToAnchor:_field.topAnchor constant:-2],

        [_plusButton.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor constant:4],
        [_plusButton.bottomAnchor constraintEqualToAnchor:_field.bottomAnchor constant:4],

        [_field.leadingAnchor constraintEqualToAnchor:_plusButton.trailingAnchor constant:2],
        [_field.trailingAnchor constraintEqualToAnchor:_actionButton.leadingAnchor constant:-8],
        [_field.bottomAnchor constraintEqualToAnchor:self.keyboardLayoutGuide.topAnchor constant:-8],

        [_textView.topAnchor constraintEqualToAnchor:_field.topAnchor],
        [_textView.bottomAnchor constraintEqualToAnchor:_field.bottomAnchor],
        [_textView.leadingAnchor constraintEqualToAnchor:_field.leadingAnchor constant:8],
        [_textView.trailingAnchor constraintEqualToAnchor:_micButton.leadingAnchor],
        _textHeight,
        [_placeholder.leadingAnchor constraintEqualToAnchor:_textView.leadingAnchor constant:5],
        [_placeholder.centerYAnchor constraintEqualToAnchor:_textView.topAnchor constant:18],
        [_micButton.trailingAnchor constraintEqualToAnchor:_field.trailingAnchor],
        [_micButton.bottomAnchor constraintEqualToAnchor:_field.bottomAnchor constant:4],

        [_actionButton.widthAnchor constraintEqualToConstant:32],
        [_actionButton.heightAnchor constraintEqualToConstant:32],
        [_actionButton.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor constant:-12],
        [_actionButton.bottomAnchor constraintEqualToAnchor:_field.bottomAnchor constant:-2],
    ]];
    // The cover for the page while it loads, under the bars.
    _curtain = [[UIView alloc] init];
    _curtain.translatesAutoresizingMaskIntoConstraints = NO;
    _curtain.backgroundColor = AppBackgroundColor();
    _curtain.hidden = YES;
    _spinner = [[UIActivityIndicatorView alloc] initWithActivityIndicatorStyle:UIActivityIndicatorViewStyleMedium];
    _spinner.translatesAutoresizingMaskIntoConstraints = NO;
    [_curtain addSubview:_spinner];
    [self insertSubview:_curtain atIndex:0];
    [NSLayoutConstraint activateConstraints:@[
        [_curtain.topAnchor constraintEqualToAnchor:_topBar.bottomAnchor],
        [_curtain.bottomAnchor constraintEqualToAnchor:_bottomBar.topAnchor],
        [_curtain.leadingAnchor constraintEqualToAnchor:self.leadingAnchor],
        [_curtain.trailingAnchor constraintEqualToAnchor:self.trailingAnchor],
        [_spinner.centerXAnchor constraintEqualToAnchor:_curtain.centerXAnchor],
        [_spinner.centerYAnchor constraintEqualToAnchor:_curtain.centerYAnchor],
        [_placeholder.trailingAnchor constraintLessThanOrEqualToAnchor:_micButton.leadingAnchor],
    ]];

    // Not the chat list button: the list works while the page still loads.
    _buttons = @[_incognitoButton, _newChatButton, _moreButton, _modelButton, _plusButton, _micButton, _actionButton];
    [self updateActionButton];
}

/// An SF Symbol for a + menu entry, by its words (nil: no picture).
+ (UIImage *)symbolForMenuTitle:(NSString *)title {
    NSString *t = title.lowercaseString;
    NSArray<NSArray<NSString *> *> *pairs = @[
        @[@"photo", @"photo.on.rectangle"], @[@"file", @"paperclip"], @[@"screenshot", @"camera.viewfinder"],
        @[@"camera", @"camera"], @[@"project", @"folder"], @[@"web search", @"globe"], @[@"research", @"magnifyingglass"],
        @[@"connector", @"puzzlepiece.extension"], @[@"skill", @"wand.and.stars"], @[@"style", @"paintbrush"],
        @[@"github", @"chevron.left.forwardslash.chevron.right"], @[@"drive", @"externaldrive"], @[@"think", @"brain"],
    ];
    for (NSArray<NSString *> *pair in pairs) {
        if ([t rangeOfString:pair[0]].location != NSNotFound) {
            return [UIImage systemImageNamed:pair[1]];
        }
    }
    return nil;
}

/// claude.ai's menu items as native menu entries. Without items, one entry
/// that shows claude.ai's own menu.
- (void)menuElementsFor:(NSString *)menu completion:(void (^)(NSArray<UIMenuElement *> *))completion {
    if (self.onMenuItems == nil) {
        completion(@[]);
        return;
    }
    __weak typeof(self) weakSelf = self;
    self.onMenuItems(menu, ^(NSArray<NSDictionary *> *items) {
        if (items == nil) {
            completion(@[]); // claude.ai's own menu is on screen
            return;
        }
        NSMutableArray<UIMenuElement *> *elements = [NSMutableArray array];
        // Items of one section (claude.ai's own group, or "Effort") follow each
        // other; each run becomes a titled part of the menu.
        NSMutableArray<UIMenuElement *> *run = [NSMutableArray array];
        __block NSString *runTitle = @"";
        void (^closeRun)(void) = ^{
            if (run.count) {
                // The current choices and the effort levels sit in the menu itself;
                // any other group of claude.ai's ("More models") is a submenu.
                BOOL inlineRun = runTitle.length == 0 || [runTitle isEqualToString:@"Effort"];
                [elements addObject:[UIMenu menuWithTitle:runTitle
                                                    image:nil
                                                identifier:nil
                                                   options:inlineRun ? UIMenuOptionsDisplayInline : 0
                                                  children:[run copy]]];
                [run removeAllObjects];
            }
        };
        for (NSDictionary *item in items) {
            NSString *title = [item[@"title"] isKindOfClass:NSString.class] ? item[@"title"] : @"";
            if (title.length == 0) {
                continue;
            }
            NSString *group = [item[@"group"] isKindOfClass:NSString.class] ? item[@"group"] : @"";
            if (![group isEqualToString:runTitle]) {
                closeRun();
                runTitle = group;
            }
            UIAction *action = [UIAction actionWithTitle:title image:nil identifier:nil handler:^(__kindof UIAction *chosen) {
                if (weakSelf.onMenuPick) {
                    weakSelf.onMenuPick(menu, item);
                }
            }];
            NSString *subtitle = [item[@"subtitle"] isKindOfClass:NSString.class] ? item[@"subtitle"] : @"";
            if (subtitle.length) {
                action.subtitle = subtitle;
            }
            if ([item[@"sub"] boolValue]) {
                action.image = [UIImage systemImageNamed:@"chevron.right"];
            } else {
                action.image = [NativeChrome symbolForMenuTitle:title];
            }
            action.state = [item[@"checked"] boolValue] ? UIMenuElementStateOn : UIMenuElementStateOff;
            if ([item[@"disabled"] boolValue]) {
                action.attributes = UIMenuElementAttributesDisabled;
            }
            [run addObject:action];
        }
        closeRun();
        if (elements.count == 0) {
            [elements addObject:[UIAction actionWithTitle:@"Show Claude's menu" image:nil identifier:nil handler:^(__kindof UIAction *chosen) {
                [weakSelf fire:menu argument:nil];
            }]];
        }
        completion(elements);
    });
}

/// The message bar with one line of text: 4 + model row 30 + 2 + text 36 + 8.
static const CGFloat kMessageBarHeight = 80;

- (UIView *)messageBar {
    return _bottomBar;
}

- (CGFloat)barHeight {
    return kMessageBarHeight + MAX(_textHeight.constant - 36, 0);
}

/// Tells the app where the page has to end (see onBarInset).
- (void)reportInset {
    CGFloat inset = (_shown && !_composerShown) ? kMessageBarHeight : 0;
    if (inset == _reportedInset) {
        return;
    }
    _reportedInset = inset;
    if (self.onBarInset) {
        self.onBarInset(inset);
    }
}

/// The bars stay up while the page is not ready (loading, or rebuilding itself),
/// with the buttons off; if the page has not come back after 15 s they go.
- (void)beginWaiting {
    if (_waiting) {
        return;
    }
    _waiting = YES;
    for (UIButton *button in _buttons) {
        button.enabled = NO;
    }
    NSUInteger token = ++_waitToken;
    __weak typeof(self) weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(15 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        typeof(self) strongSelf = weakSelf;
        if (strongSelf && strongSelf->_waiting && strongSelf->_waitToken == token) {
            strongSelf->_waiting = NO;
            [strongSelf uncoverPage];
            [strongSelf setShown:NO];
        }
    });
}

- (void)endWaiting {
    if (!_waiting) {
        return;
    }
    _waiting = NO;
    _waitToken += 1;
    for (UIButton *button in _buttons) {
        button.enabled = YES;
    }
}

- (void)showWhileLoading {
    _shown = YES;
    self.hidden = NO;
    self.alpha = 1;
    [self beginWaiting];
    [self reportInset];
    [self coverPage];
}

- (void)coverPage {
    if (!_shown || _composerShown) {
        return;
    }
    [_curtain.layer removeAllAnimations];
    _curtain.alpha = 1;
    _curtain.hidden = NO;
    [_spinner startAnimating];
    NSUInteger token = ++_coverToken;
    __weak typeof(self) weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(8 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        typeof(self) strongSelf = weakSelf;
        if (strongSelf && strongSelf->_coverToken == token) {
            [strongSelf uncoverPage];
        }
    });
}

- (void)uncoverPage {
    if (_curtain.hidden) {
        return;
    }
    NSUInteger token = ++_coverToken;
    // A moment for the page to draw with claude.ai's controls already hidden.
    [UIView animateWithDuration:0.2 delay:0.3 options:UIViewAnimationOptionBeginFromCurrentState animations:^{
        self->_curtain.alpha = 0;
    } completion:^(BOOL finished) {
        if (self->_coverToken == token) {
            self->_curtain.hidden = YES;
            [self->_spinner stopAnimating];
        }
    }];
}

- (void)setShown:(BOOL)show {
    if (show == _shown) {
        return;
    }
    _shown = show;
    [self reportInset];
    if (!show && _textView.isFirstResponder) {
        [_textView resignFirstResponder];
    }
    if (show) {
        self.hidden = NO;
    }
    [UIView animateWithDuration:0.2 animations:^{
        self.alpha = show ? 1 : 0;
    } completion:^(BOOL finished) {
        if (!self->_shown) {
            self.hidden = YES;
        }
    }];
}

/// The top bar reaches as far down as claude.ai's own (CSS px, converted with
/// the page's layout width); the tallest seen is kept so the bar does not jump
/// between pages.
- (void)coverTopHeight:(CGFloat)cssHeight viewWidth:(CGFloat)cssWidth {
    if (cssHeight <= 0 || cssWidth <= 0 || self.bounds.size.width <= 0) {
        return;
    }
    CGFloat points = ceil(cssHeight * self.bounds.size.width / cssWidth);
    points = MIN(MAX(points, 44), 72);
    if (points > _topBarBottom.constant) {
        _topBarBottom.constant = points;
        [NSUserDefaults.standardUserDefaults setDouble:points forKey:kChromeTopHeightKey];
    }
}

- (void)setTopColor:(UIColor *)top bottomColor:(UIColor *)bottom dark:(BOOL)dark {
    _topBar.backgroundColor = top;
    _bottomBar.backgroundColor = bottom;
    _curtain.backgroundColor = top;
    self.overrideUserInterfaceStyle = dark ? UIUserInterfaceStyleDark : UIUserInterfaceStyleLight;
}

- (void)setModel:(NSString *)model effort:(NSString *)effort {
    UIFont *font = [UIFont systemFontOfSize:15];
    NSMutableAttributedString *title = [[NSMutableAttributedString alloc] initWithString:model.length ? model : @"Model"
        attributes:@{NSFontAttributeName: font, NSForegroundColorAttributeName: UIColor.secondaryLabelColor}];
    if (effort.length) {
        [title appendAttributedString:[[NSAttributedString alloc] initWithString:[@" " stringByAppendingString:effort]
            attributes:@{NSFontAttributeName: font, NSForegroundColorAttributeName: UIColor.tertiaryLabelColor}]];
    }
    UIButtonConfiguration *config = _modelButton.configuration;
    config.attributedTitle = title;
    _modelButton.configuration = config;
}

- (NSString *)trimmedText {
    return [_textView.text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
}

/// One button at the right of the message bar: stop while Claude answers, send
/// when there is text, voice mode otherwise.
- (void)updateActionButton {
    BOOL hasText = [self trimmedText].length > 0;
    UIImage *image;
    UIColor *background;
    UIColor *tint;
    NSString *label;
    if (_dictating) {
        _actionName = @"dictateFinish";
        image = SymbolImage(@"checkmark", 15, UIImageSymbolWeightBold);
        background = self.tintColor;
        tint = UIColor.whiteColor;
        label = @"Finish dictation";
    } else if (_streaming && !hasText) {
        // Stop while Claude answers; typed text can still be sent (claude.ai
        // takes it as the next message).
        _actionName = @"stop";
        image = SymbolImage(@"stop.fill", 13, UIImageSymbolWeightRegular);
        background = UIColor.labelColor;
        tint = UIColor.systemBackgroundColor;
        label = @"Stop";
    } else if (hasText || !_voice) {
        _actionName = @"send";
        image = SymbolImage(@"arrow.up", 15, UIImageSymbolWeightBold);
        // The bar's own tint: UIColor.tintColor would follow this button's tint,
        // which is the white of its arrow (a blank white circle, 13 Nov).
        background = hasText ? self.tintColor : UIColor.tertiarySystemFillColor;
        tint = hasText ? UIColor.whiteColor : UIColor.tertiaryLabelColor;
        label = @"Send";
    } else {
        _actionName = @"voice";
        image = SymbolImage(@"waveform", 19, UIImageSymbolWeightRegular);
        background = UIColor.clearColor;
        tint = self.tintColor;
        label = @"Voice mode";
    }
    [_actionButton setImage:image forState:UIControlStateNormal];
    _actionButton.backgroundColor = background;
    _actionButton.tintColor = tint;
    _actionButton.accessibilityLabel = label;
    _micButton.hidden = _streaming && !hasText;
}

- (void)textViewDidChange:(UITextView *)textView {
    _placeholder.hidden = textView.text.length > 0;
    CGFloat width = textView.bounds.size.width > 0 ? textView.bounds.size.width : 260;
    CGFloat needed = [textView sizeThatFits:CGSizeMake(width, CGFLOAT_MAX)].height;
    _textHeight.constant = MIN(MAX(needed, 36), 140);
    textView.scrollEnabled = needed > 140;
    [self updateActionButton];
}

- (void)applyState:(NSDictionary *)state {
    BOOL ready = [state[@"ready"] boolValue];
    BOOL sidebarOpen = [state[@"sidebarOpen"] boolValue];
    NSString *page = [state[@"page"] isKindOfClass:NSString.class] ? state[@"page"] : @"";
    BOOL inChat = [page isEqualToString:@"chat"];
    // Not ready on a chat page means loading or a moment of rebuilding: the bars
    // stay. Any other page (settings, sign-in) has no use for them.
    if (!ready && _shown && ![page isEqualToString:@"other"]) {
        [self beginWaiting];
        return;
    }
    [self endWaiting];
    [self uncoverPage]; // in use, or a page the bars are not for
    if (ready) {
        [self coverTopHeight:[state[@"topHeight"] doubleValue] viewWidth:[state[@"viewWidth"] doubleValue]];
    }
    _streaming = [state[@"streaming"] boolValue];
    _voice = [state[@"voice"] boolValue];

    NSString *title = [state[@"title"] isKindOfClass:NSString.class] ? state[@"title"] : @"";
    _titleLabel.text = title.length ? title : (inChat ? @"Chat" : @"New chat");
    _incognitoButton.hidden = inChat || ![state[@"incognito"] boolValue];
    _newChatButton.hidden = !inChat;
    _moreButton.hidden = !inChat;
    _moreButton.enabled = [state[@"more"] boolValue];
    // While claude.ai dictates: the mic becomes cancel (red x), the action
    // button becomes finish (tick), the field says it is listening.
    BOOL dictating = [state[@"dictating"] boolValue];
    _dictating = dictating;
    _micButton.enabled = dictating || [state[@"dictate"] boolValue];
    [_micButton setImage:SymbolImage(dictating ? @"xmark" : @"mic", 19, UIImageSymbolWeightRegular) forState:UIControlStateNormal];
    _micButton.tintColor = dictating ? UIColor.systemRedColor : UIColor.secondaryLabelColor;
    _micButton.accessibilityLabel = dictating ? @"Cancel dictation" : @"Dictate";
    NSString *heard = [state[@"dictationText"] isKindOfClass:NSString.class] ? state[@"dictationText"] : @"";
    _placeholder.text = dictating ? (heard.length ? heard : @"Listening…") : @"Message";
    _placeholder.lineBreakMode = dictating ? NSLineBreakByTruncatingHead : NSLineBreakByTruncatingTail;
    NSString *model = [state[@"model"] isKindOfClass:NSString.class] ? state[@"model"] : @"";
    NSString *effort = [state[@"effort"] isKindOfClass:NSString.class] ? state[@"effort"] : @"";
    [self setModel:model effort:effort];
    [self setAttachments:[state[@"attachments"] isKindOfClass:NSArray.class] ? state[@"attachments"] : @[]];
    [self updateActionButton];

    // Words dictated in claude.ai's box arrive here, to be sent from this bar.
    NSString *dictated = [state[@"dictated"] isKindOfClass:NSString.class] ? state[@"dictated"] : @"";
    if (dictated.length) {
        NSString *current = _textView.text ?: @"";
        BOOL needsSpace = current.length > 0 && ![current hasSuffix:@" "] && ![current hasSuffix:@"\n"];
        _textView.text = [NSString stringWithFormat:@"%@%@%@", current, needsSpace ? @" " : @"", dictated];
        [self textViewDidChange:_textView];
    }

    // Voice mode and dictation run in claude.ai's own message box: the app's
    // message bar steps aside for it, the top bar stays.
    BOOL composerShown = ready && [state[@"composerShown"] boolValue];
    if (composerShown != _composerShown) {
        _composerShown = composerShown;
        _bottomBar.hidden = composerShown;
        if (composerShown && _textView.isFirstResponder) {
            [_textView resignFirstResponder];
        }
        [self reportInset];
    }

    [self setShown:ready && !sidebarOpen];
}

- (BOOL)editing {
    return _textView.isFirstResponder;
}

- (void)finishSend:(BOOL)sent {
    if (sent) {
        _textView.text = @"";
        [self textViewDidChange:_textView];
    }
    if (_refocusAfterSend) {
        [_textView becomeFirstResponder];
    }
    _refocusAfterSend = NO;
}

- (void)setAttachments:(NSArray *)names {
    NSMutableArray<UIMenuElement *> *items = [NSMutableArray array];
    __weak typeof(self) weakSelf = self;
    [names enumerateObjectsUsingBlock:^(id name, NSUInteger index, BOOL *stop) {
        if (![name isKindOfClass:NSString.class]) {
            return;
        }
        UIAction *remove = [UIAction actionWithTitle:[@"Remove " stringByAppendingString:name]
                                               image:[UIImage systemImageNamed:@"xmark.circle"]
                                          identifier:nil
                                             handler:^(__kindof UIAction *action) {
            [weakSelf fire:@"removeAttachment" argument:[NSString stringWithFormat:@"%lu", (unsigned long)index]];
        }];
        remove.attributes = UIMenuElementAttributesDestructive;
        [items addObject:remove];
    }];
    _attachButton.hidden = items.count == 0;
    if (items.count == 0) {
        return;
    }
    UIButtonConfiguration *config = _attachButton.configuration;
    config.title = [NSString stringWithFormat:@"%lu", (unsigned long)items.count];
    _attachButton.configuration = config;
    _attachButton.accessibilityLabel = [NSString stringWithFormat:@"%lu attached", (unsigned long)items.count];
    _attachButton.menu = [UIMenu menuWithTitle:items.count == 1 ? @"1 file attached" : [NSString stringWithFormat:@"%lu files attached", (unsigned long)items.count]
                                      children:items];
}

- (void)fire:(NSString *)name argument:(NSString *)argument {
    if (self.onAction) {
        self.onAction(name, argument);
    }
}

- (void)menuTapped {
    [_textView resignFirstResponder];
    [self fire:@"sidebar" argument:nil];
}
- (void)incognitoTapped { [self fire:@"incognito" argument:nil]; }
- (void)newChatTapped { [self fire:@"newChat" argument:nil]; }
- (void)moreTapped {
    [_textView resignFirstResponder];
    [self fire:@"more" argument:nil];
}
- (void)plusTapped {
    [_textView resignFirstResponder];
    [self fire:@"plus" argument:nil];
}
- (void)modelTapped {
    [_textView resignFirstResponder];
    [self fire:@"model" argument:nil];
}
- (void)micTapped { [self fire:_dictating ? @"dictateCancel" : @"dictate" argument:nil]; }
- (void)actionTapped {
    if ([_actionName isEqualToString:@"send"]) {
        NSString *text = [self trimmedText];
        if (text.length == 0) {
            return;
        }
        _refocusAfterSend = _textView.isFirstResponder;
        [[[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleLight] impactOccurred];
        [self fire:@"send" argument:text];
    } else if ([_actionName isEqualToString:@"dictateFinish"]) {
        [self fire:_actionName argument:nil]; // the keyboard stays: the words come to this bar
    } else {
        [_textView resignFirstResponder];
        [self fire:_actionName argument:nil];
    }
}

@end
