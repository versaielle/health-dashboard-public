const state = {
  userRole: null, userEmail: null, userName: null,
  userGroceryData: { staples: [], items: [] },
  familyGroceryData: [],
  familyAccessList: [],
  nutritionistAccessList: [],
  myItemsPushLoading: false, myItemsPushResults: null,
  myItemAdd: { open:false, type:'item', query:'', searching:false, results:null, selectedIdx:0, note:'' },
  familyItemQty: {},
  fsQuickLogOpen: false, fsQuickLogSlot: 'other',
  tab:'day', viewDay:'today', meetingHour:9,
  meals:[], mealsLoading:false, macroDate:null,
  waterWindows:{}, // per-window fluid ounces, keyed by WATER_WINDOWS id
  checked:{}, krogerConnected:false, authPending:false,
  pushResults:null, pushLoading:false,
  showCustom:false, customMeal:{name:'',kcal:'',protein:'',carbs:'',fat:''},
  logPanel:null, logPanelServings:{}, staplePortion:{}, componentPortions:{},
  pollInterval:null,
  wakeOverrides: {}, workoutOverrides: {}, wfhDays: {0:false,1:false,2:false,3:true,4:true,5:true,6:false},
  calUrls:[], calEvents:[], calTomorrowEvents:[],
  calLoading:false, calError:null,
  newCalUrl:'', newCalName:'',
  msStatus:{bba:false,craft:false},
  googleConnected:false, googleCalendars:[],
  ignoredConflicts:[],
  theme:'dark',
  settingsOpen:false,
  // Recipes
  _recipeDraftNotes:'',
  recipes:[],
  recipeCreateForm:{
    name:'',mealType:'dinner',cuisine:'Mexican',cookTime:30,servings:4,
    weekendOnly:false,kidPlate:'',notes:'',ingredients:[],steps:[]
  },
  recipeCreateIngSearch:{query:'',results:[],loading:false,food:null,servingIdx:0,qty:1},
  recipeView:null,
  // Per-ingredient City Market search panel: { recipeId, idx, term, loading, results, selecting } | null
  ingredientSearch:null,
  recipeGenerating:false,
  recipeGenForm:{ mealType:'dinner', cuisine:'', cookTime:'', notes:'' },
  generatedRecipe:null,
  // URL recipe import: { url, loading, error, source } — source is the host the
  // imported recipe came from, shown on the review banner.
  recipeImport:{ url:'', loading:false, error:null, source:null },
  recipeRemixing:false,
  recipeRemixDirection:'',
  recipeSubTab:'library',
  weeklyDrawerOpen:false,
  waterDrawerOpen:false,
  recipeScaleServings:{},
  recipeIngredientOverrides:{},
  weeklyPlan:new Set(),
  recipeIngredientExcludes:new Set(),  // non-spice items marked "already have"
  recipeIngredientIncludes:new Set(),  // spice items explicitly marked "need to buy"
  // FatSecret food search
  fsQuery:'', fsResults:[], fsLoading:false, fsError:null,
  fsFood:null, fsFoodLoading:false,
  fsServingIdx:{}, fsServingQty:{},
  // Cart item nutrition labels (keyed by `item::productIdx`)
  cartNutrition:{}, cartNutritionLoading:{},
  cartNutritionQuery:{}, cartNutritionResults:{}, cartNutritionSearching:{},
  cartSourceRecipeId: null,
  // Cart review
  // Per-item metadata: { sources:[{recipeId,ingIndex}], ingredientName, amount, unit,
  //   chosenUpc/chosenName/chosenSize (pre-matched product), fraction (of one package) }
  cartItemMeta:{},
  cartSearchResults:null,
  cartSearchLoading:false,
  cartConfirmed:{},
  cartQuantities:{},
  cartReSearchTerms:{},
  cartReSearching:{},
  cartReSearchOpen:{},
  cartPushLoading:false,
  cartPushResults:null,
  // Pantry
  pantry:[],
  // Meal prep
  preparedMeals:[],
  preparePanel:null,
  // Pantry manual add
  pantryAddOpen:false,
  pantryFsContainerServings:1,
  // Admin: backfill recipe components
  backfillRunning:false, backfillResult:null, backfillErrorsOpen:false,
  // Owner: nutrition verification backfill
  nutriVerifyRunning:false, nutriVerifyProgress:null,
};

function save() {
  const s = {
    checked:state.checked, meetingHour:state.meetingHour,
    viewDay:state.viewDay, ignoredConflicts:state.ignoredConflicts, wakeOverrides:state.wakeOverrides, workoutOverrides:state.workoutOverrides, wfhDays:state.wfhDays, theme:state.theme,
    weeklyPlan:[...state.weeklyPlan],
    recipeIngredientExcludes:[...state.recipeIngredientExcludes],
    recipeIngredientIncludes:[...state.recipeIngredientIncludes],
    recipeScaleServings:state.recipeScaleServings,
    pantry:state.pantry,
  };
  localStorage.setItem('hstack', JSON.stringify(s));
}

function load() {
  try {
    const s = JSON.parse(localStorage.getItem('hstack') || '{}');
    if (s.weeklyPlan) { state.weeklyPlan = new Set(s.weeklyPlan); delete s.weeklyPlan; }
    if (s.recipeIngredientExcludes) { state.recipeIngredientExcludes = new Set(s.recipeIngredientExcludes); delete s.recipeIngredientExcludes; }
    if (s.recipeIngredientIncludes) { state.recipeIngredientIncludes = new Set(s.recipeIngredientIncludes); delete s.recipeIngredientIncludes; }
    delete s.alcohol; delete s.zyn;
    if (s.pantry) { state.pantry = s.pantry; delete s.pantry; }
    Object.assign(state, s);
  } catch {}
}
