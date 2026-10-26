/***************************************************************************
 *   fheroes2: https://github.com/ihhub/fheroes2                           *
 *   Copyright (C) 2026                                                    *
 *                                                                         *
 *   This program is free software; you can redistribute it and/or modify  *
 *   it under the terms of the GNU General Public License as published by  *
 *   the Free Software Foundation; either version 2 of the License, or     *
 *   (at your option) any later version.                                   *
 *                                                                         *
 *   This program is distributed in the hope that it will be useful,       *
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of        *
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the         *
 *   GNU General Public License for more details.                          *
 *                                                                         *
 *   You should have received a copy of the GNU General Public License     *
 *   along with this program; if not, write to the                         *
 *   Free Software Foundation, Inc.,                                       *
 *   59 Temple Place - Suite 330, Boston, MA  02111-1307, USA.             *
 ***************************************************************************/

#pragma once

#include <string>

namespace System
{
    // Brings the contents of one animation file into the file system of the engine, which for the
    // WebAssembly build is memory that starts out holding only placeholders of these files: the bytes
    // themselves stay in the storage of the browser until something is about to watch them. Every
    // file this has fetched is dropped again as soon as another one is asked for, so the peak is a
    // single film rather than the sum of the animation folder.
    //
    // Returns true if the file may be read, which is always the case outside the WebAssembly build.
    bool LoadAnimationFile( const std::string & filePath );
}
