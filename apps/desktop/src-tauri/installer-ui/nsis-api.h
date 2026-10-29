#pragma once
// NSIS 3.11 plugin ABI declarations, adapted from Examples/Plugin/nsis/api.h
// and pluginapi.h: https://github.com/kichik/nsis/tree/v311/Contrib/ExDLL
// Copyright (C) 1999-2025 Nullsoft and Contributors
// SPDX-License-Identifier: Zlib
//
// This software is provided 'as-is', without any express or implied warranty.
// In no event will the authors be held liable for any damages arising from the
// use of this software.
// Permission is granted to anyone to use this software for any purpose,
// including commercial applications, and to alter it and redistribute it
// freely, subject to the following restrictions:
// 1. The origin of this software must not be misrepresented; you must not claim
//    that you wrote the original software. If you use this software in a
//    product, an acknowledgment in the product documentation would be
//    appreciated but is not required.
// 2. Altered source versions must be plainly marked as such, and must not be
//    misrepresented as being the original software.
// 3. This notice may not be removed or altered from any source distribution.

struct NsisStack {
  NsisStack* next;
  WCHAR text[1];
};
struct NsisFlags {
  int autoclose;
  int all_user_var;
  int exec_error;
  int abort;
  int exec_reboot;
  int reboot_called;
  int reserved;
  int plugin_api_version;
  int silent;
  int instdir_error;
  int rtl;
  int errlvl;
  int alter_reg_view;
  int status_update;
};
struct NsisExtra {
  NsisFlags* flags;
  int(__stdcall* execute)(int, HWND);
  void(__stdcall* validate_filename)(LPWSTR);
  int(__stdcall* register_callback)(HMODULE, UINT_PTR(__cdecl*)(int));
};
constexpr UINT kOuterNext = WM_USER + 8;
constexpr UINT kCustomReady = WM_USER + 13;
constexpr WPARAM kByeBye = 'x';
