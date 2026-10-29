#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <commctrl.h>
#include <dwmapi.h>
#include <objidl.h>
#include <gdiplus.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <strsafe.h>
#include <windowsx.h>

#include "nsis-api.h"

using namespace Gdiplus;

namespace {
constexpr int kWidth = 560;
constexpr int kHeight = 400;
constexpr int kPath = 101;
constexpr int kBrowse = 102;
constexpr int kOption = 103;
constexpr int kPrimary = 104;
constexpr int kSecondary = 105;
constexpr int kClose = 106;
constexpr int kMinimize = 107;
constexpr UINT_PTR kTimer = 1;
enum class Stage {
  Ready,
  Installing,
  CancelConfirm,
  Cancelling,
  Complete,
  Failed
};
HINSTANCE module = nullptr;
HWND host = nullptr;
HWND nativePage = nullptr;
HWND nativeProgress = nullptr;
NsisExtra* api = nullptr;
ULONG_PTR graphicsToken = 0;
HRESULT comResult = E_FAIL;
bool customPage = false;
bool openApplication = false;
bool shortcutsAllowed = true;
// 0=可取消，1=文件替换，2=确认取消，3=已请求取消。
volatile LONG installGate = 0;
HANDLE decision = nullptr;
WCHAR failure[1024] = L"";
WCHAR selectedPath[1024] = L"";
bool createShortcut = true;
constexpr UINT kCommit = WM_APP + 1;
constexpr UINT kInstallDone = WM_USER + 4;
LRESULT CALLBACK WindowProcedure(HWND, UINT, WPARAM, LPARAM);
void ClosePage();

HWND window = nullptr;
HWND pathInput = nullptr;
HWND browse = nullptr;
HWND option = nullptr;
HWND primary = nullptr;
HWND secondary = nullptr;
HWND closeButton = nullptr;
HWND minimizeButton = nullptr;
HWND hovered = nullptr;
HFONT inputFont = nullptr;
Image* logo = nullptr;
IStream* logoStream = nullptr;
Stage stage = Stage::Ready;
float scale = 1.0f;
int progress = 0;
WCHAR installPath[1024] = L"";

int Px(float value) {
  return static_cast<int>(value * scale + 0.5f);
}

Color Ink(BYTE value) {
  return Color(255, value, value, value);
}

void Rounded(Graphics& graphics, RectF rect, float radius, Color fill,
             Color stroke = Color(0, 0, 0, 0)) {
  GraphicsPath shape;
  const float diameter = radius * 2;
  shape.AddArc(rect.X, rect.Y, diameter, diameter, 180, 90);
  shape.AddArc(rect.GetRight() - diameter, rect.Y, diameter, diameter, 270, 90);
  shape.AddArc(rect.GetRight() - diameter, rect.GetBottom() - diameter,
               diameter, diameter, 0, 90);
  shape.AddArc(rect.X, rect.GetBottom() - diameter, diameter, diameter, 90, 90);
  shape.CloseFigure();
  SolidBrush brush(fill);
  graphics.FillPath(&brush, &shape);
  if (stroke.GetA() != 0) {
    Pen pen(stroke, 1);
    graphics.DrawPath(&pen, &shape);
  }
}

void Text(Graphics& graphics, const WCHAR* value, RectF rect, float size,
          Color color, bool bold = false,
          StringAlignment alignment = StringAlignmentNear) {
  Font font(L"Microsoft YaHei UI", size,
            bold ? FontStyleBold : FontStyleRegular, UnitPixel);
  StringFormat format;
  format.SetAlignment(alignment);
  format.SetLineAlignment(StringAlignmentCenter);
  format.SetFormatFlags(StringFormatFlagsNoWrap);
  format.SetTrimming(StringTrimmingEllipsisCharacter);
  SolidBrush brush(color);
  graphics.DrawString(value, -1, &font, rect, &format, &brush);
}

void SetupGraphics(Graphics& graphics) {
  graphics.SetSmoothingMode(SmoothingModeAntiAlias);
  graphics.SetTextRenderingHint(TextRenderingHintAntiAliasGridFit);
  graphics.ScaleTransform(scale, scale);
}

bool ShowFocus(HWND control) {
  return GetFocus() == control &&
         (SendMessageW(control, WM_QUERYUISTATE, 0, 0) & UISF_HIDEFOCUS) == 0;
}

void Present(Bitmap& frame, Graphics& graphics, HDC destination) {
  // 背景与文字合成后一次呈现，避免悬停重绘暴露空白中间帧。
  graphics.Flush(FlushIntentionSync);
  Graphics target(destination);
  target.DrawImage(&frame, 0, 0);
}

void Layout() {
  MoveWindow(pathInput, Px(62), Px(218), Px(362), Px(24), TRUE);
  MoveWindow(browse, Px(440), Px(213), Px(64), Px(32), TRUE);
  MoveWindow(option, Px(48), Px(264), Px(202), Px(30), TRUE);
  const bool twoActions =
      stage == Stage::Complete || stage == Stage::CancelConfirm;
  MoveWindow(primary, Px(twoActions ? 96.0f : 48.0f), Px(336),
             Px(twoActions ? 224.0f : 464.0f), Px(32), TRUE);
  MoveWindow(secondary, Px(332), Px(336), Px(132), Px(32), TRUE);
  MoveWindow(closeButton, Px(512), Px(8), Px(36), Px(30), TRUE);
  MoveWindow(minimizeButton, Px(472), Px(8), Px(36), Px(30), TRUE);
  if (inputFont != nullptr) {
    DeleteObject(inputFont);
  }
  inputFont =
      CreateFontW(-Px(13), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                  DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                  CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
  SendMessageW(pathInput, WM_SETFONT, reinterpret_cast<WPARAM>(inputFont),
               TRUE);
}

void SetStage(Stage next) {
  KillTimer(window, kTimer);
  stage = next;
  const bool ready = next == Stage::Ready;
  const bool complete = next == Stage::Complete;
  const bool confirming = next == Stage::CancelConfirm;
  const bool failed = next == Stage::Failed;
  const bool cancelling = next == Stage::Cancelling;
  ShowWindow(pathInput, ready ? SW_SHOW : SW_HIDE);
  ShowWindow(browse, ready ? SW_SHOW : SW_HIDE);
  ShowWindow(option, ready && shortcutsAllowed ? SW_SHOW : SW_HIDE);
  ShowWindow(secondary, complete || confirming ? SW_SHOW : SW_HIDE);
  ShowWindow(closeButton, complete ? SW_HIDE : SW_SHOW);
  ShowWindow(minimizeButton, complete ? SW_HIDE : SW_SHOW);
  SetWindowTextW(primary, ready        ? L"安装"
                          : complete   ? L"打开应用"
                          : confirming ? L"继续安装"
                          : failed     ? L"关闭"
                          : cancelling ? L"正在取消"
                                       : L"取消");
  SetWindowTextW(secondary, complete ? L"关闭" : L"退出安装");
  SetWindowTextW(host, ready        ? L"Pi Desk · 安装"
                       : complete   ? L"Pi Desk · 安装完成"
                       : confirming ? L"Pi Desk · 取消安装"
                       : failed     ? L"Pi Desk · 安装未完成"
                       : cancelling ? L"Pi Desk · 正在取消"
                                    : L"Pi Desk · 正在安装");
  EnableWindow(primary, ready ? GetWindowTextLengthW(pathInput) > 0
                              : !cancelling && (next != Stage::Installing ||
                                                installGate == 0));
  EnableWindow(closeButton,
               !cancelling && (next != Stage::Installing || installGate == 0));
  Layout();
  InvalidateRect(window, nullptr, TRUE);
  SetFocus(primary);
  if (next == Stage::Installing || confirming || cancelling) {
    SetTimer(window, kTimer, 100, nullptr);
  }
}

void RequestClose() {
  if (stage == Stage::Installing) {
    ResetEvent(decision);
    if (InterlockedCompareExchange(&installGate, 2, 0) == 0) {
      SetStage(Stage::CancelConfirm);
    } else {
      SetEvent(decision);
    }
  } else if (stage == Stage::CancelConfirm) {
    InterlockedExchange(&installGate, 0);
    SetEvent(decision);
    SetStage(Stage::Installing);
  } else if (stage == Stage::Ready || stage == Stage::Complete ||
             stage == Stage::Failed) {
    if (stage == Stage::Complete) {
      PostMessageW(host, WM_COMMAND, IDOK, 0);
    } else {
      PostMessageW(host, WM_COMMAND, IDCANCEL, 0);
    }
  }
}

void PrimaryAction() {
  if (stage == Stage::Ready) {
    if (GetWindowTextLengthW(pathInput) == 0) {
      SetFocus(pathInput);
      return;
    }
    PostMessageW(host, WM_COMMAND, IDOK, 0);
  } else if (stage == Stage::Installing || stage == Stage::CancelConfirm) {
    RequestClose();
  } else if (stage == Stage::Complete) {
    openApplication = true;
    PostMessageW(host, WM_COMMAND, IDOK, 0);
  } else if (stage == Stage::Failed) {
    RequestClose();
  }
}

void ChooseFolder() {
  IFileOpenDialog* dialog = nullptr;
  const HRESULT result =
      CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER,
                       IID_PPV_ARGS(&dialog));
  if (FAILED(result)) {
    SetFocus(pathInput);
    return;
  }
  DWORD options = 0;
  dialog->GetOptions(&options);
  dialog->SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM |
                     FOS_DONTADDTORECENT);
  dialog->SetTitle(L"选择安装位置");
  if (SUCCEEDED(dialog->Show(window))) {
    IShellItem* item = nullptr;
    if (SUCCEEDED(dialog->GetResult(&item))) {
      PWSTR selected = nullptr;
      if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &selected))) {
        SetWindowTextW(pathInput, selected);
        CoTaskMemFree(selected);
      }
      item->Release();
    }
  }
  dialog->Release();
}

void PaintOption(HWND control, HDC destination) {
  RECT client;
  GetClientRect(control, &client);
  Bitmap frame(client.right, client.bottom, PixelFormat32bppPARGB);
  Graphics graphics(&frame);
  graphics.Clear(Ink(250));
  SetupGraphics(graphics);
  const bool checked = SendMessageW(control, BM_GETCHECK, 0, 0) == BST_CHECKED;
  if (ShowFocus(control)) {
    Rounded(graphics, RectF(0.5f, 4.5f, 21, 21), 5, Color(0, 0, 0, 0),
            Ink(100));
  }
  Rounded(graphics, RectF(3, 7, 16, 16), 4, checked ? Ink(38) : Ink(255),
          checked ? Ink(38) : Ink(139));
  if (checked) {
    Pen tick(Ink(255), 1.7f);
    tick.SetStartCap(LineCapRound);
    tick.SetEndCap(LineCapRound);
    graphics.DrawLine(&tick, 7.0f, 15.0f, 10.0f, 18.0f);
    graphics.DrawLine(&tick, 10.0f, 18.0f, 15.0f, 12.0f);
  }
  Text(graphics, L"创建桌面快捷方式", RectF(29, 0, 173, 30), 13, Ink(82));
  Present(frame, graphics, destination);
}

void DrawButton(const DRAWITEMSTRUCT& item) {
  Bitmap frame(item.rcItem.right, item.rcItem.bottom, PixelFormat32bppPARGB);
  Graphics graphics(&frame);
  graphics.Clear(Ink(item.CtlID == kBrowse ? 255 : 250));
  SetupGraphics(graphics);
  const float width = static_cast<float>(item.rcItem.right) / scale;
  const float height = static_cast<float>(item.rcItem.bottom) / scale;
  const bool hot = hovered == item.hwndItem;
  const bool down = (item.itemState & ODS_SELECTED) != 0;
  const bool disabled = (item.itemState & ODS_DISABLED) != 0;
  const RectF bounds(1, 1, width - 2, height - 2);
  if (item.CtlID == kPrimary || item.CtlID == kSecondary) {
    const bool filled = item.CtlID == kPrimary && stage != Stage::Installing;
    Rounded(graphics, bounds, 6,
            filled ? Ink(disabled ? 190
                         : down   ? 12
                         : hot    ? 52
                                  : 32)
                   : Ink(down  ? 231
                         : hot ? 240
                               : 250),
            filled ? Color(0, 0, 0, 0) : Ink(205));
    WCHAR label[40];
    GetWindowTextW(item.hwndItem, label, 40);
    // 补偿当前字体栅格化后约一个设备像素的上偏，平衡可见字形的上下留白。
    const RectF labelBounds(16, 4 + 1 / scale, width - 32, height - 8);
    Text(graphics, label, labelBounds, 14,
         filled     ? Ink(255)
         : disabled ? Ink(155)
                    : Ink(55),
         false, StringAlignmentCenter);
  } else if (item.CtlID == kClose || item.CtlID == kMinimize) {
    if (hot || down) {
      Rounded(graphics, bounds, 5, Ink(down ? 226 : 237));
    }
    Pen pen(Ink(disabled ? 175 : 90), 1.2f);
    if (item.CtlID == kClose) {
      graphics.DrawLine(&pen, 14.0f, 11.0f, 22.0f, 19.0f);
      graphics.DrawLine(&pen, 14.0f, 19.0f, 22.0f, 11.0f);
    } else {
      graphics.DrawLine(&pen, 13.0f, 15.0f, 23.0f, 15.0f);
    }
  } else {
    if (hot || down) {
      Rounded(graphics, bounds, 6, Ink(down ? 231 : 242));
    }
    Text(graphics, L"更改", bounds, 12, Ink(65), false, StringAlignmentCenter);
  }
  if (ShowFocus(item.hwndItem)) {
    const float radius =
        item.CtlID == kPrimary || item.CtlID == kSecondary ? 6.0f : 8.0f;
    Rounded(graphics, RectF(0.8f, 0.8f, width - 1.6f, height - 1.6f), radius,
            Color(0, 0, 0, 0), Ink(100));
  }
  Present(frame, graphics, item.hDC);
}

void PaintWindow(HDC target) {
  RECT client;
  GetClientRect(window, &client);
  Bitmap frame(client.right, client.bottom, PixelFormat32bppPARGB);
  Graphics graphics(&frame);
  graphics.Clear(Ink(250));
  SetupGraphics(graphics);
  const float logoY = stage == Stage::Ready ? 48.0f : 70.0f;
  if (logo != nullptr) {
    graphics.SetInterpolationMode(InterpolationModeHighQualityBicubic);
    graphics.DrawImage(logo, RectF(250, logoY, 60, 60));
  }
  const WCHAR* heading = stage == Stage::Ready        ? L"Pi Desk"
                         : stage == Stage::Installing ? L"正在安装"
                         : stage == Stage::Complete   ? L"安装完成"
                         : stage == Stage::Cancelling ? L"正在取消"
                         : stage == Stage::Failed
                             ? (installGate == 3 ? L"安装已取消" : L"安装失败")
                             : L"取消安装？";
  Text(graphics, heading, RectF(48, logoY + 74, 464, 38), 24, Ink(34), true,
       StringAlignmentCenter);
  if (stage == Stage::Ready) {
    Text(graphics, L"安装位置", RectF(48, 178, 464, 24), 12, Ink(100));
    Rounded(graphics, RectF(48, 208, 464, 42), 8, Ink(255), Ink(222));
  } else if (stage == Stage::Installing || stage == Stage::Cancelling) {
    Rounded(graphics, RectF(64, 234, 432, 6), 3, Ink(228));
    if (progress > 1) {
      Rounded(graphics, RectF(64, 234, 432 * progress / 100.0f, 6), 3, Ink(46));
    }
    WCHAR percent[16];
    StringCchPrintfW(percent, 16, L"%d%%", progress);
    Text(graphics, percent, RectF(64, 254, 432, 26), 12, Ink(100), false,
         StringAlignmentCenter);
  }
  if (stage == Stage::Failed && installGate != 3 && failure[0] != L'\0') {
    Font font(L"Microsoft YaHei UI", 13, FontStyleRegular, UnitPixel);
    StringFormat format;
    format.SetAlignment(StringAlignmentCenter);
    format.SetLineAlignment(StringAlignmentCenter);
    SolidBrush brush(Ink(90));
    graphics.DrawString(failure, -1, &font, RectF(48, 208, 464, 108), &format,
                        &brush);
  }
  Present(frame, graphics, target);
}

LRESULT CALLBACK ControlProcedure(HWND control, UINT message, WPARAM wParam,
                                  LPARAM lParam, UINT_PTR, DWORD_PTR) {
  const bool isOption = GetDlgCtrlID(control) == kOption;
  if (message == WM_ERASEBKGND) {
    return 1;
  }
  if (isOption && message == WM_PAINT) {
    PAINTSTRUCT paint;
    HDC dc = BeginPaint(control, &paint);
    PaintOption(control, dc);
    EndPaint(control, &paint);
    return 0;
  }
  if (isOption && message == WM_PRINTCLIENT) {
    PaintOption(control, reinterpret_cast<HDC>(wParam));
    return 0;
  }
  if (!isOption && message == BM_SETSTYLE) {
    // 对话框默认按钮切换不应把自绘按钮改成系统绘制样式。
    return 0;
  }
  if (message == WM_LBUTTONDOWN) {
    SendMessageW(window, WM_CHANGEUISTATE, MAKEWPARAM(UIS_SET, UISF_HIDEFOCUS),
                 0);
  }
  if (!isOption && message == WM_MOUSEMOVE && hovered != control) {
    HWND old = hovered;
    hovered = control;
    if (old != nullptr) {
      InvalidateRect(old, nullptr, FALSE);
    }
    TRACKMOUSEEVENT track{sizeof(TRACKMOUSEEVENT), TME_LEAVE, control, 0};
    TrackMouseEvent(&track);
    InvalidateRect(control, nullptr, FALSE);
  } else if (!isOption && message == WM_MOUSELEAVE) {
    if (hovered == control) {
      hovered = nullptr;
    }
    InvalidateRect(control, nullptr, FALSE);
  } else if (message == WM_SETCURSOR) {
    SetCursor(LoadCursorW(nullptr, IDC_HAND));
    return TRUE;
  }
  const LRESULT result = DefSubclassProc(control, message, wParam, lParam);
  if (message == WM_SETFOCUS || message == WM_KILLFOCUS ||
      message == WM_UPDATEUISTATE ||
      (isOption && (message == BM_SETCHECK || message == BM_SETSTATE))) {
    InvalidateRect(control, nullptr, FALSE);
  }
  return result;
}

HWND Button(int id, const WCHAR* label, DWORD type = BS_OWNERDRAW) {
  HWND control = CreateWindowExW(
      0, L"BUTTON", label, WS_CHILD | WS_VISIBLE | WS_TABSTOP | type, 0, 0, 0,
      0, window, reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)), module,
      nullptr);
  SetWindowSubclass(control, ControlProcedure, 1, 0);
  return control;
}

LRESULT CALLBACK WindowProcedure(HWND handle, UINT message, WPARAM wParam,
                                 LPARAM lParam) {
  switch (message) {
    case WM_LBUTTONDOWN:
      if (GET_Y_LPARAM(lParam) < Px(40)) {
        ReleaseCapture();
        SendMessageW(host, WM_NCLBUTTONDOWN, HTCAPTION, 0);
      }
      return 0;
    case WM_CREATE: {
      window = handle;
      pathInput =
          CreateWindowExW(0, L"EDIT", installPath,
                          WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_AUTOHSCROLL,
                          0, 0, 0, 0, handle, reinterpret_cast<HMENU>(kPath),
                          GetModuleHandleW(nullptr), nullptr);
      SendMessageW(pathInput, EM_SETLIMITTEXT, 1023, 0);
      browse = Button(kBrowse, L"更改");
      option = Button(kOption, L"创建桌面快捷方式", BS_AUTOCHECKBOX);
      SendMessageW(option, BM_SETCHECK, BST_CHECKED, 0);
      primary = Button(kPrimary, L"安装");
      secondary = Button(kSecondary, L"关闭");
      minimizeButton = Button(kMinimize, L"最小化");
      closeButton = Button(kClose, L"关闭");
      SendMessageW(handle, WM_CHANGEUISTATE,
                   MAKEWPARAM(UIS_SET, UISF_HIDEFOCUS), 0);
      SetStage(stage);
      return 0;
    }
    case DM_GETDEFID:
      return MAKELRESULT(kPrimary, DC_HASDEFID);
    case WM_NEXTDLGCTL: {
      HWND next = lParam != 0
                      ? reinterpret_cast<HWND>(wParam)
                      : GetNextDlgTabItem(handle, GetFocus(), wParam != 0);
      SetFocus(next);
      return 0;
    }
    case WM_COMMAND:
      if (LOWORD(wParam) == kPath && HIWORD(wParam) == EN_CHANGE &&
          primary != nullptr) {
        EnableWindow(primary, GetWindowTextLengthW(pathInput) > 0);
      } else if (HIWORD(wParam) == BN_CLICKED) {
        switch (LOWORD(wParam)) {
          case IDOK:
          case kPrimary:
            PrimaryAction();
            break;
          case IDCANCEL:
          case kClose:
            RequestClose();
            break;
          case kSecondary:
            if (stage == Stage::CancelConfirm) {
              InterlockedExchange(&installGate, 3);
              SetEvent(decision);
              SetStage(Stage::Cancelling);
            } else {
              openApplication = false;
              PostMessageW(host, WM_COMMAND, IDOK, 0);
            }
            break;
          case kBrowse:
            ChooseFolder();
            break;
          case kOption:
            InvalidateRect(option, nullptr, FALSE);
            break;
          case kMinimize:
            ShowWindow(host, SW_MINIMIZE);
            break;
        }
      }
      return 0;
    case WM_TIMER:
      if (wParam == kTimer && nativeProgress != nullptr) {
        PBRANGE range{};
        SendMessageW(nativeProgress, PBM_GETRANGE, FALSE,
                     reinterpret_cast<LPARAM>(&range));
        const int position =
            static_cast<int>(SendMessageW(nativeProgress, PBM_GETPOS, 0, 0));
        const int value =
            range.iHigh > range.iLow
                ? (position - range.iLow) * 100 / (range.iHigh - range.iLow)
                : 0;
        if (value != progress) {
          progress = value;
          RECT area{Px(60), Px(230), Px(500), Px(284)};
          InvalidateRect(handle, &area, FALSE);
        }
      }
      return 0;
    case WM_DRAWITEM:
      DrawButton(*reinterpret_cast<DRAWITEMSTRUCT*>(lParam));
      return TRUE;
    case WM_CTLCOLOREDIT:
      SetTextColor(reinterpret_cast<HDC>(wParam), RGB(65, 65, 65));
      SetBkColor(reinterpret_cast<HDC>(wParam), RGB(255, 255, 255));
      return reinterpret_cast<LRESULT>(GetStockObject(WHITE_BRUSH));
    case WM_ERASEBKGND:
      return 1;
    case WM_PAINT: {
      PAINTSTRUCT paint;
      HDC dc = BeginPaint(handle, &paint);
      PaintWindow(dc);
      EndPaint(handle, &paint);
      return 0;
    }
    case WM_PRINTCLIENT:
      PaintWindow(reinterpret_cast<HDC>(wParam));
      return 0;
    case kCommit:
      if (stage == Stage::Installing) {
        EnableWindow(primary, FALSE);
        EnableWindow(closeButton, FALSE);
      }
      return 0;
    case WM_CLOSE:
      RequestClose();
      return 0;
    case WM_DESTROY:
      KillTimer(handle, kTimer);
      if (window == handle) {
        window = nullptr;
      }
      return 0;
  }
  return DefWindowProcW(handle, message, wParam, lParam);
}

void Pop(NsisStack** stack, WCHAR* value, size_t capacity) {
  value[0] = L'\0';
  if (*stack != nullptr) {
    NsisStack* item = *stack;
    StringCchCopyW(value, capacity, item->text);
    *stack = item->next;
    GlobalFree(item);
  }
}

void Push(NsisStack** stack, int stringSize, const WCHAR* value) {
  auto* item = static_cast<NsisStack*>(
      GlobalAlloc(GPTR, sizeof(NsisStack) + stringSize * sizeof(WCHAR)));
  StringCchCopyW(item->text, stringSize, value);
  item->next = *stack;
  *stack = item;
}

void ClosePage() {
  if (window != nullptr) {
    DestroyWindow(window);
    window = nullptr;
  }
}

void HideStandardControls() {
  for (HWND child = GetWindow(host, GW_CHILD); child != nullptr;
       child = GetWindow(child, GW_HWNDNEXT)) {
    if (child != window) {
      ShowWindow(child, SW_HIDE);
    }
  }
}

LRESULT CALLBACK HostProcedure(HWND handle, UINT message, WPARAM wParam,
                               LPARAM lParam, UINT_PTR, DWORD_PTR) {
  if (message == WM_NCCALCSIZE && wParam != 0) {
    return 0;
  }
  if (message == WM_CLOSE) {
    RequestClose();
    return 0;
  }
  if (message == WM_COMMAND && LOWORD(wParam) == IDCANCEL &&
      (stage == Stage::Installing || stage == Stage::CancelConfirm ||
       stage == Stage::Cancelling)) {
    RequestClose();
    return 0;
  }
  if (message == WM_DPICHANGED) {
    scale = static_cast<float>(HIWORD(wParam)) / 96.0f;
    const RECT* bounds = reinterpret_cast<RECT*>(lParam);
    SetWindowPos(handle, nullptr, bounds->left, bounds->top, Px(kWidth),
                 Px(kHeight), SWP_NOZORDER);
    if (window != nullptr) {
      MoveWindow(window, 0, 0, Px(kWidth), Px(kHeight), TRUE);
      Layout();
      InvalidateRect(window, nullptr, TRUE);
    }
    return 0;
  }
  if (message == kOuterNext && customPage) {
    HWND page = window;
    const LRESULT result = DefSubclassProc(handle, message, wParam, lParam);
    if (result == 0 && window == page) {
      ClosePage();
    }
    return result;
  }
  return DefSubclassProc(handle, message, wParam, lParam);
}

LRESULT CALLBACK InstallProcedure(HWND handle, UINT message, WPARAM wParam,
                                  LPARAM lParam, UINT_PTR, DWORD_PTR) {
  if (message == WM_WINDOWPOSCHANGING) {
    auto* position = reinterpret_cast<WINDOWPOS*>(lParam);
    position->flags = (position->flags & ~SWP_SHOWWINDOW) | SWP_HIDEWINDOW;
  }
  const bool failed = message == kInstallDone && api->flags->abort != 0;
  if (failed) {
    KillTimer(window, kTimer);
    GetWindowTextW(GetDlgItem(handle, 1006), failure, 1024);
    if (failure[0] == L'\0') {
      StringCchCopyW(failure, 1024,
                     L"安装未完成，请检查安装位置和文件占用后重试。");
    }
  }
  const LRESULT result = DefSubclassProc(handle, message, wParam, lParam);
  if (message == kInstallDone && window != nullptr) {
    if (failed) {
      SetStage(Stage::Failed);
    }
    HideStandardControls();
    SetFocus(primary);
  }
  return result;
}

void CreatePage(Stage value) {
  ClosePage();
  stage = value;
  window = CreateWindowExW(WS_EX_CONTROLPARENT, L"PiDeskInstallerPage", L"",
                           WS_CHILD | WS_CLIPCHILDREN, 0, 0, Px(kWidth),
                           Px(kHeight), host, nullptr, module, nullptr);
  HideStandardControls();
  SetWindowPos(window, HWND_TOP, 0, 0, Px(kWidth), Px(kHeight), SWP_SHOWWINDOW);
}

void ShowCustom(Stage value) {
  customPage = true;
  CreatePage(value);
  SendMessageW(host, kCustomReady, reinterpret_cast<WPARAM>(window), 0);
  SetFocus(primary);
  MSG message;
  while (window != nullptr && IsWindow(host) &&
         GetMessageW(&message, nullptr, 0, 0) > 0) {
    if (message.message == WM_KEYDOWN && message.wParam == VK_TAB) {
      SendMessageW(window, WM_CHANGEUISTATE,
                   MAKEWPARAM(UIS_CLEAR, UISF_HIDEFOCUS), 0);
    }
    if (!IsDialogMessageW(window, &message) &&
        !IsDialogMessageW(host, &message)) {
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
  }
  customPage = false;
}

void Cleanup() {
  ClosePage();
  if (host != nullptr && IsWindow(host)) {
    RemoveWindowSubclass(host, HostProcedure, 1);
  }
  host = nullptr;
  if (inputFont != nullptr) {
    DeleteObject(inputFont);
    inputFont = nullptr;
  }
  delete logo;
  logo = nullptr;
  if (logoStream != nullptr) {
    logoStream->Release();
    logoStream = nullptr;
  }
  if (graphicsToken != 0) {
    GdiplusShutdown(graphicsToken);
    graphicsToken = 0;
  }
  if (SUCCEEDED(comResult)) {
    CoUninitialize();
    comResult = E_FAIL;
  }
  if (decision != nullptr) {
    CloseHandle(decision);
    decision = nullptr;
  }
  UnregisterClassW(L"PiDeskInstallerPage", module);
}

UINT_PTR __cdecl PluginCallback(int message) {
  if (message == 1 || message == 0) {
    Cleanup();
  }
  return 0;
}
}  // namespace

extern "C" void Init(HWND parent, int stringSize, WCHAR*, NsisStack** stack,
                     NsisExtra* extra) {
  host = parent;
  api = extra;
  extra->register_callback(module, PluginCallback);
  comResult = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  GdiplusStartupInput startup;
  if (GdiplusStartup(&graphicsToken, &startup, nullptr) != Ok) {
    Push(stack, stringSize, L"error");
    return;
  }
  decision = CreateEventW(nullptr, TRUE, TRUE, nullptr);
  HRSRC resource = FindResourceW(module, MAKEINTRESOURCEW(201), RT_RCDATA);
  const DWORD length = SizeofResource(module, resource);
  HGLOBAL data = GlobalAlloc(GMEM_MOVEABLE, length);
  CopyMemory(GlobalLock(data), LockResource(LoadResource(module, resource)),
             length);
  GlobalUnlock(data);
  if (SUCCEEDED(CreateStreamOnHGlobal(data, TRUE, &logoStream))) {
    logo = Image::FromStream(logoStream);
  } else {
    GlobalFree(data);
  }
  WNDCLASSEXW windowClass{sizeof(WNDCLASSEXW)};
  windowClass.lpfnWndProc = WindowProcedure;
  windowClass.hInstance = module;
  windowClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  windowClass.lpszClassName = L"PiDeskInstallerPage";
  RegisterClassExW(&windowClass);
  scale = static_cast<float>(GetDpiForWindow(parent)) / 96.0f;
  SetWindowSubclass(parent, HostProcedure, 1, 0);
  SetWindowLongPtrW(
      parent, GWL_STYLE,
      GetWindowLongPtrW(parent, GWL_STYLE) | WS_CLIPCHILDREN | WS_MINIMIZEBOX);
  int corner = 2;
  DwmSetWindowAttribute(parent, 33, &corner, sizeof(corner));
  COLORREF border = RGB(220, 220, 220);
  DwmSetWindowAttribute(parent, 34, &border, sizeof(border));
  MARGINS margins{1, 1, 1, 1};
  DwmExtendFrameIntoClientArea(parent, &margins);
  RECT work;
  SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
  SetWindowPos(parent, nullptr,
               work.left + (work.right - work.left - Px(kWidth)) / 2,
               work.top + (work.bottom - work.top - Px(kHeight)) / 2,
               Px(kWidth), Px(kHeight), SWP_NOZORDER | SWP_FRAMECHANGED);
  Push(stack, stringSize, L"ok");
}

extern "C" void Ready(HWND, int, WCHAR*, NsisStack** stack, NsisExtra*) {
  WCHAR shortcutMode[16];
  Pop(stack, installPath, 1024);
  Pop(stack, shortcutMode, 16);
  shortcutsAllowed = lstrcmpW(shortcutMode, L"1") != 0;
  ShowCustom(Stage::Ready);
}

extern "C" void ReadOptions(HWND, int stringSize, WCHAR*, NsisStack** stack,
                            NsisExtra*) {
  WCHAR entered[1024];
  GetWindowTextW(pathInput, entered, 1024);
  const DWORD length = GetFullPathNameW(entered, 1024, selectedPath, nullptr);
  if (entered[0] == L'\0' || length == 0 || length >= 1024) {
    selectedPath[0] = L'\0';
  }
  createShortcut = shortcutsAllowed &&
                   SendMessageW(option, BM_GETCHECK, 0, 0) == BST_CHECKED;
  Push(stack, stringSize, createShortcut ? L"1" : L"0");
  Push(stack, stringSize, selectedPath);
}

extern "C" void Progress(HWND parent, int, WCHAR*, NsisStack**, NsisExtra*) {
  nativePage = FindWindowExW(parent, nullptr, L"#32770", nullptr);
  nativeProgress = GetDlgItem(nativePage, 1004);
  progress = 0;
  SetWindowSubclass(nativePage, InstallProcedure, 1, 0);
  CreatePage(Stage::Installing);
}

extern "C" void Finish(HWND, int stringSize, WCHAR*, NsisStack** stack,
                       NsisExtra*) {
  nativePage = nullptr;
  nativeProgress = nullptr;
  ShowCustom(Stage::Complete);
  Push(stack, stringSize, openApplication ? L"1" : L"0");
}

extern "C" void Gate(HWND, int stringSize, WCHAR*, NsisStack** stack,
                     NsisExtra*) {
  WCHAR action[16];
  Pop(stack, action, 16);
  const bool commit = lstrcmpW(action, L"commit") == 0;
  for (;;) {
    LONG gate = InterlockedCompareExchange(&installGate, commit ? 1 : 0, 0);
    if (gate == 2) {
      WaitForSingleObject(decision, INFINITE);
      continue;
    }
    if (commit && gate != 3 && window != nullptr) {
      PostMessageW(window, kCommit, 0, 0);
    }
    Push(stack, stringSize, gate == 3 ? L"1" : L"0");
    return;
  }
}

extern "C" void Destroy(HWND, int, WCHAR*, NsisStack**, NsisExtra*) {
  Cleanup();
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    module = instance;
    DisableThreadLibraryCalls(instance);
  }
  return TRUE;
}
